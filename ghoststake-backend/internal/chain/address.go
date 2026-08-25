package chain

import (
	"fmt"

	"github.com/ethereum/go-ethereum/common"
)

func commonAddress(s string) common.Address { return common.HexToAddress(s) }

// ParseAddress converts a hex string to an address, refusing anything that is
// not one.
//
// The refusal is the point. common.HexToAddress never fails: it left-pads
// short input and truncates long input, so "0xdeadbeef" and a typo'd address
// both become perfectly valid addresses that no user holds. Every call made
// against them succeeds and returns zeros, which read as a real position with
// no collateral — which is to say, a liquidatable one.
func ParseAddress(s string) (common.Address, error) {
	if !common.IsHexAddress(s) {
		return common.Address{}, fmt.Errorf("not a valid address: %q", s)
	}
	return common.HexToAddress(s), nil
}
