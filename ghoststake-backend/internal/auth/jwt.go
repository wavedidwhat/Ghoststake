package auth

import (
	"errors"
	"fmt"
	"time"

	"github.com/golang-jwt/jwt/v5"
)

var ErrInvalidToken = errors.New("invalid or expired token")

type Claims struct {
	Address string `json:"address"`
	jwt.RegisteredClaims
}

type TokenIssuer struct {
	secret []byte
	ttl    time.Duration
}

func NewTokenIssuer(secret []byte, ttl time.Duration) *TokenIssuer {
	return &TokenIssuer{secret: secret, ttl: ttl}
}

func (t *TokenIssuer) Issue(address string) (string, time.Time, error) {
	now := time.Now()
	exp := now.Add(t.ttl)

	tok := jwt.NewWithClaims(jwt.SigningMethodHS256, Claims{
		Address: address,
		RegisteredClaims: jwt.RegisteredClaims{
			Subject:   address,
			IssuedAt:  jwt.NewNumericDate(now),
			NotBefore: jwt.NewNumericDate(now),
			ExpiresAt: jwt.NewNumericDate(exp),
		},
	})

	signed, err := tok.SignedString(t.secret)
	if err != nil {
		return "", time.Time{}, fmt.Errorf("sign token: %w", err)
	}
	return signed, exp, nil
}

func (t *TokenIssuer) Parse(tokenStr string) (*Claims, error) {
	claims := &Claims{}
	// The algorithm is pinned explicitly. Without this, a token could arrive
	// with alg=none (or an asymmetric alg) and be accepted unsigned.
	_, err := jwt.ParseWithClaims(tokenStr, claims, func(tok *jwt.Token) (any, error) {
		if _, ok := tok.Method.(*jwt.SigningMethodHMAC); !ok {
			return nil, fmt.Errorf("unexpected signing method %v", tok.Header["alg"])
		}
		return t.secret, nil
	}, jwt.WithValidMethods([]string{jwt.SigningMethodHS256.Alg()}))
	if err != nil {
		return nil, ErrInvalidToken
	}
	return claims, nil
}
