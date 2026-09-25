package keeper_test

import (
	"testing"

	"github.com/ethereum/go-ethereum/crypto"

	"forge.wavedidwhat.com/wave/ghoststake/internal/keeper"
)

func TestIsEventOracleReadsTheDispatchTable(t *testing.T) {
	question := crypto.Keccak256([]byte("question()"))[:4]
	feed := crypto.Keccak256([]byte("feed()"))[:4]

	if !keeper.IsEventOracle(append([]byte{0x60, 0x80}, question...)) {
		t.Fatal("an oracle whose bytecode answers question() is an event oracle")
	}
	if keeper.IsEventOracle(append([]byte{0x60, 0x80}, feed...)) {
		t.Fatal("a price adapter is not an event oracle")
	}
	if keeper.IsEventOracle(nil) {
		t.Fatal("an address with no code is not an event oracle")
	}
}
