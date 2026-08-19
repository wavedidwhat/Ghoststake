package chain

import "github.com/ethereum/go-ethereum/common"

func commonAddress(s string) common.Address { return common.HexToAddress(s) }
