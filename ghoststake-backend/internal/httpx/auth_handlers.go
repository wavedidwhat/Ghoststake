package httpx

import (
	"encoding/json"
	"errors"
	"log/slog"
	"net/http"
	"time"

	"github.com/wavedidwhat/ghoststake/internal/auth"
	"github.com/wavedidwhat/ghoststake/internal/store"
)

type nonceRequest struct {
	Address string `json:"address"`
}

type nonceResponse struct {
	Nonce     string    `json:"nonce"`
	Message   string    `json:"message"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// handleNonce issues the challenge the wallet will sign.
//
// The response includes the fully rendered SIWE message so the frontend passes
// it straight to personal_sign without composing anything itself. The server
// keeps its own copy and verifies against that, not against whatever comes back.
func (s *Server) handleNonce(w http.ResponseWriter, r *http.Request) {
	var req nonceRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}

	address, err := auth.NormalizeAddress(req.Address)
	if err != nil {
		writeError(w, http.StatusBadRequest, "invalid ethereum address")
		return
	}

	nonce, err := auth.NewNonce()
	if err != nil {
		slog.Error("generate nonce", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	issuedAt := time.Now()
	expiresAt := issuedAt.Add(s.cfg.NonceTTL)
	message := auth.BuildMessage(s.cfg.AppDomain, address, s.cfg.AppURI, s.cfg.ChainID, nonce, issuedAt)

	err = s.store.CreateNonce(r.Context(), store.Nonce{
		Nonce:   nonce,
		Address: address,
		Message: message,
	}, expiresAt)
	if err != nil {
		slog.Error("persist nonce", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, nonceResponse{Nonce: nonce, Message: message, ExpiresAt: expiresAt})
}

type verifyRequest struct {
	Nonce     string `json:"nonce"`
	Signature string `json:"signature"`
}

type verifyResponse struct {
	Token     string    `json:"token"`
	Address   string    `json:"address"`
	ExpiresAt time.Time `json:"expiresAt"`
}

// handleVerify checks the signature and issues a session token.
//
// Note what the client does NOT send: the address and the message. Both are
// looked up server-side from the nonce. A client can therefore only prove
// control of the address the server already bound to that challenge; it cannot
// nominate a different one.
func (s *Server) handleVerify(w http.ResponseWriter, r *http.Request) {
	var req verifyRequest
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, 8<<10)).Decode(&req); err != nil {
		writeError(w, http.StatusBadRequest, "invalid request body")
		return
	}
	if req.Nonce == "" || req.Signature == "" {
		writeError(w, http.StatusBadRequest, "nonce and signature are required")
		return
	}

	// Atomically claims the nonce, so it cannot be verified twice.
	issued, err := s.store.ConsumeNonce(r.Context(), req.Nonce)
	if errors.Is(err, store.ErrNonceUnusable) {
		writeError(w, http.StatusUnauthorized, "authentication failed")
		return
	}
	if err != nil {
		slog.Error("consume nonce", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	if err := auth.VerifySignature(issued.Message, req.Signature, issued.Address); err != nil {
		// Logged at info, not error: a bad signature is an expected client
		// outcome, not a server fault.
		slog.Info("signature verification failed", "address", issued.Address, "err", err)
		writeError(w, http.StatusUnauthorized, "authentication failed")
		return
	}

	if _, err := s.store.UpsertUserOnLogin(r.Context(), issued.Address); err != nil {
		slog.Error("upsert user", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	token, expiresAt, err := s.tokens.Issue(issued.Address)
	if err != nil {
		slog.Error("issue token", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, verifyResponse{Token: token, Address: issued.Address, ExpiresAt: expiresAt})
}

type meResponse struct {
	Address     string     `json:"address"`
	CreatedAt   time.Time  `json:"createdAt"`
	LastLoginAt *time.Time `json:"lastLoginAt"`
}

func (s *Server) handleMe(w http.ResponseWriter, r *http.Request) {
	address, ok := AddressFromContext(r.Context())
	if !ok {
		writeError(w, http.StatusUnauthorized, "unauthorized")
		return
	}

	user, err := s.store.UserByAddress(r.Context(), address)
	if errors.Is(err, store.ErrNotFound) {
		writeError(w, http.StatusNotFound, "user not found")
		return
	}
	if err != nil {
		slog.Error("load user", "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
		return
	}

	writeJSON(w, http.StatusOK, meResponse{
		Address:     user.Address,
		CreatedAt:   user.CreatedAt,
		LastLoginAt: user.LastLoginAt,
	})
}
