import { bech32, bech32m } from "@scure/base";
import { describe, expect, it } from "vitest";
import { checkAddress, isValidTxHash, sameAddress, toChecksumAddress } from "../shared/addresses.ts";
import { addressMessage } from "../shared/address-words.ts";
import { CHAINS } from "../shared/chains.ts";
import { addressVariants } from "../server/address-variants.ts";
import { isPlaceholder, placeholderFor } from "../server/placeholders.ts";

const SOL = "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB";
const EVM = "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96045";
const TRON = "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6t";
const CARDANO_103 = "addr1qx2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzer3n0d3vllmyqwsx5wktcd8cc3sq835lu7drv2xwl2wywfgse35a3x";

function ok(chain: string, address: string): string {
  const result = checkAddress(chain, address);
  if (!result.ok) throw new Error(`${chain} rejected ${address}: ${result.error}`);
  return result.address;
}

function bad(chain: string, address: unknown): string {
  const result = checkAddress(chain, address);
  if (result.ok) throw new Error(`${chain} accepted ${String(address)}`);
  return result.error;
}

describe("EVM addresses", () => {
  it("accepts checksummed addresses and returns the checksum form", () => {
    for (const address of [EVM, "0x5aAeb6053F3E94C9b9A09f33669435E7Ef1BeAed", "0xfB6916095ca1df60bB79Ce92cE3Ea74c37c5d359"]) {
      expect(ok("eth", address)).toBe(address);
      expect(ok("bsc", address.toLowerCase())).toBe(address);
    }
  });

  it("rejects a wrong checksum, wrong length and non-hex", () => {
    expect(bad("eth", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA96044".replace("d8dA", "D8dA"))).toBe("checksum");
    expect(bad("eth", "0xD8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe("checksum");
    expect(bad("eth", "0xd8dA6BF26964aF9D7eEd9e03E53415D37aA9604")).toBe("format");
    expect(bad("eth", "d8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe("format");
    expect(bad("eth", "0xZ8dA6BF26964aF9D7eEd9e03E53415D37aA96045")).toBe("format");
  });

  it("rejects burn addresses", () => {
    expect(bad("eth", "0x0000000000000000000000000000000000000000")).toBe("burn");
    expect(bad("base", "0x000000000000000000000000000000000000dEaD")).toBe("burn");
  });

  it("applies to every EVM chain", () => {
    for (const chain of ["bsc", "eth", "base", "arb", "op", "pol", "avax", "gnosis", "bera", "monad", "xlayer", "plasma", "scroll", "hood", "adi", "hypercore"]) {
      expect(ok(chain, EVM)).toBe(EVM);
    }
  });

  it("builds the EIP-55 form", () => {
    expect(toChecksumAddress("0xd8da6bf26964af9d7eed9e03e53415d37aa96045")).toBe(EVM);
  });
});

describe("Solana addresses", () => {
  it("accepts 32-byte base58 keys", () => {
    expect(ok("sol", SOL)).toBe(SOL);
    expect(ok("sol", "BYPsjxa3YuZESQz1dKuBw1QSFCSpecsm8nCQhY5xbU1Z")).toBeTruthy();
    expect(ok("fogo", SOL)).toBe(SOL);
  });
  it("refuses well-known program and burn addresses, which nobody can spend from", () => {
    for (const program of [
      "11111111111111111111111111111111",
      "1nc1nerator11111111111111111111111111111111",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
      "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
      "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL",
      "So11111111111111111111111111111111111111112",
    ]) {
      expect(bad("sol", program), program).toBe("burn");
    }
  });

  it("rejects other lengths and characters", () => {
    expect(bad("sol", SOL.slice(0, -4))).toBe("format");
    expect(bad("sol", SOL.replace("9", "0"))).toBe("format");
    expect(bad("sol", TRON)).toBe("format");
  });
});

describe("Bitcoin addresses", () => {
  it("accepts legacy, P2SH, bech32 and taproot", () => {
    for (const address of [
      "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa",
      "3J98t1WpEZ73CNmQviecrnyiWrnqRhWNLy",
      "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4",
      "bc1qrp33g0q5c5txsp9arysrx4k6zdkfs4nce4xj0gdcccefvpysxf3qccfmv3",
      "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqzk5jj0",
    ]) {
      expect(ok("btc", address)).toBe(address);
    }
  });
  it("lower-cases upper-case bech32", () => {
    expect(ok("btc", "BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4")).toBe("bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4");
  });
  it("rejects typos, test-network and wrong-version addresses", () => {
    expect(bad("btc", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNb")).toBe("checksum");
    expect(bad("btc", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t5")).toBe("checksum");
    expect(bad("btc", "tb1qw508d6qejxtdg4y5r3zarvary0c5xw7kxpjzsx")).not.toBe("");
    // A witness v1 program encoded with the old checksum must fail.
    expect(bad("btc", "bc1p0xlxvlhemja6c4dqv22uapctqupfhlxm9h8z3k2e72q4k9hcz7vqh2y7hd")).toBe("checksum");
    expect(bad("btc", "LLnCCHbSzfwWquEdaS5TF2Yt7uz5Qb1SZ1")).toBe("format");
  });
});

describe("Zcash addresses", () => {
  it("accepts transparent addresses only", () => {
    expect(ok("zec", "t1KRqwQhktLV4BjbNLiuH6pb3AMoszZKcQB")).toBeTruthy();
  });
  it("rejects shielded and unified addresses with a clear reason", () => {
    expect(bad("zec", "zs1z7rejlpsa98s2rrrfkwmaxu53e4ue0ulcrw0h4x5g8jl04tak0d3mm47vdtahatqrlkngh9sly")).toBe("zcash_shielded");
    expect(bad("zec", "u1l8xunezsvhq8fgzfl7404m450nwnd76zshscn6nfys7vyz2ywyh4cc5daaq0c7q2su5lqfh23sp7fkf3kt27ve5948mzpfdvckzaect2jtte308mkwlycj2u0eac077wu70vqcetkxf")).toBe("zcash_shielded");
    expect(bad("zec", "zcU1Cd6zYyZCd2VJF8yKgmzjxdiiU1rgTTjEwoN1CGUWCziPkUTXUjXmX7TMqdMNsTfuiGN1jQoVN4kGxUR4sAPN4XZ7pxb")).toBe("zcash_shielded");
  });
  it("rejects a Bitcoin address", () => {
    expect(bad("zec", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe("format");
  });
});

describe("Tron addresses", () => {
  it("accepts base58check addresses starting with T", () => {
    expect(ok("tron", TRON)).toBe(TRON);
    expect(ok("tron", "TBXSw8fM4jpQkGc6zZjsVABFpVN7UvXPdV")).toBeTruthy();
  });
  it("rejects typos and other chains", () => {
    expect(bad("tron", "TR7NHqjeKQxGTCi8q8ZY4pL8otSzgjLj6u")).toBe("checksum");
    expect(bad("tron", "1A1zP1eP5QGefi2DMPTfTL5SLmv7DivfNa")).toBe("format");
  });
});

describe("NEAR accounts", () => {
  it("accepts named and implicit accounts", () => {
    for (const account of ["alice.near", "token.sweat", "a-b_c.d.near", "ab".repeat(32), "0x" + "ab".repeat(20)]) expect(ok("near", account)).toBe(account);
  });
  it("rejects malformed accounts", () => {
    for (const account of ["Alice.near", "alice", ".near", "alice..near", "a", "alice.near.", "-alice.near", "x".repeat(65) + ".near", "AB".repeat(32)]) {
      expect(bad("near", account)).toBe("format");
    }
  });
});

describe("other chains", () => {
  it("accepts valid addresses", () => {
    const cases: Array<[string, string]> = [
      ["doge", "D6hLULEGDRbk86j58t5iWmeinqM6acA16V"],
      ["ltc", "LLnCCHbSzfwWquEdaS5TF2Yt7uz5Qb1SZ1"],
      ["ltc", bech32.encode("ltc", [0, ...bech32.toWords(new Uint8Array(20).fill(7))])],
      ["ltc", bech32m.encode("ltc", [1, ...bech32m.toWords(new Uint8Array(32).fill(7))])],
      ["dash", "XcF5mKwWsiv3k394GBQNpYAuk3CVJ48Xnp"],
      ["bch", "1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu"],
      ["xrp", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTh"],
      ["xrp", "rDsbeomae4FXwgQTJp9Rs64Qg9vDiTCdBv"],
      ["stellar", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN"],
      ["stellar", "GBD7QFQVR4QWNEJSHP4VN7RAAUKXTMZ4EJ4EBMCR7CP3HMF7RXEASTD7"],
      ["ton", "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs"],
      ["ton", "EQAWzEKcdnykvXfUNouqdS62tvrp32bCxuKS6eQrS6ISgcLo"],
      ["sui", "0xcc64b79a3adf4d3c21ad25a97e3ecbe83e659e68964f62e6a1da8a037346a4ce"],
      ["aptos", "0x334f8a73c50a796093399e6a7136092a9cab920b6c8096c13836666cd1a6b7dc"],
      ["movement", "0x334f8a73c50a796093399e6a7136092a9cab920b6c8096c13836666cd1a6b7dc"],
      ["starknet", "0x033068F6539f8e6e6b131e6B2B814e6c34A5224bC66947c47DaB9dFeE93b35fb"],
      ["cardano", CARDANO_103],
      ["cardano", "addr1v8wfpcg4qfhmnzprzysj6j9c53u5j56j8rvhyjp08s53s6g07rfjm"],
      ["aleo", "aleo1qqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqqq3ljyzc"],
      ["aleo", "aleo1kelm7k8786anyygg788ntlgkx4uqkmkpj7k5ugfuqchd8rnf858sun3qcr"],
      ["qtc", "qzjqcX6UoeVpFp2Gscqt477KwiR9A2ss6RDgMLaxqCf3fA7rK"],
    ];
    for (const [chain, address] of cases) expect(ok(chain, address), `${chain} ${address}`).toBeTruthy();
  });

  it("normalises Bitcoin Cash to the prefixed form", () => {
    expect(ok("bch", "qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a")).toBe("bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a");
    expect(ok("bch", "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a")).toBe("bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a");
    expect(bad("bch", "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6q")).toBe("checksum");
  });

  it("accepts only the one canonical spelling of a Bitcoin Cash address", () => {
    const good = "qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a";
    // Rebuilds an address with a valid checksum from 34 payload characters.
    const charset = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
    const generators = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
    const polymod = (values: number[]) => {
      let c = 1n;
      for (const d of values) {
        const top = c >> 35n;
        c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
        generators.forEach((g, i) => {
          if ((top >> BigInt(i)) & 1n) c ^= g;
        });
      }
      return c ^ 1n;
    };
    const withChecksum = (payload: string) => {
      const prefix = [..."bitcoincash"].map((ch) => ch.charCodeAt(0) & 0x1f);
      const values = [...payload].map((ch) => charset.indexOf(ch));
      const mod = polymod([...prefix, 0, ...values, 0, 0, 0, 0, 0, 0, 0, 0]);
      let sum = "";
      for (let i = 0; i < 8; i++) sum += charset[Number((mod >> BigInt(5 * (7 - i))) & 31n)];
      return payload + sum;
    };
    expect(withChecksum(good.slice(0, 34))).toBe(good);
    // The same destination with its two padding bits set: a different string that some software accepts.
    const last = charset.indexOf(good.charAt(33));
    const padded = withChecksum(good.slice(0, 33) + charset[last | 0b11]);
    expect(padded).not.toBe(good);
    expect(bad("bch", padded)).toBe("format");
    // Size bits other than zero (second character beyond q, p, z, r) are not a 160-bit address.
    expect(bad("bch", withChecksum(`qy${good.slice(2, 34)}`))).toBe("format");
    expect(ok("bch", good)).toBe(`bitcoincash:${good}`);
  });

  it("refuses addresses that carry a tag or memo", () => {
    expect(bad("xrp", "X7AcgcsBL6XDcUb289X4mJ8djcdyKaB5hJDWMArnXr61cqZ")).toBe("xrp_tag");
    expect(bad("stellar", "MA7QYNF7SOWQ3GLR2BGMZEHXAVIRZA4KVWLTJJFC7MGXUA74P7UJVAAAAAAAAAAAAAJLK")).toBe("stellar_muxed");
  });

  it("rejects typos", () => {
    expect(bad("xrp", "rHb9CJAWyB4rj91VRWn96DkukG4bwdtyTi")).toBe("checksum");
    expect(bad("stellar", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVM")).toBe("checksum");
    expect(bad("ton", "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDt")).toBe("checksum");
    expect(bad("cardano", CARDANO_103.slice(0, -1) + "y")).toBe("checksum");
    expect(bad("qtc", "qzjqcX6UoeVpFp2Gscqt477KwiR9A2ss6RDgMLaxqCf3fA7rL")).toBe("checksum");
    expect(bad("sui", "0x1234")).toBe("format");
    expect(bad("starknet", EVM)).toBe("format");
    expect(bad("starknet", "0x" + "f".repeat(64))).toBe("format");
  });

  it("rejects test-network addresses", () => {
    expect(bad("cardano", "addr_test1vz2fxv2umyhttkxyxp8x0dlpdt3k6cwng5pxj3jhsydzerspjrlsz")).toBe("testnet");
  });

  it("handles a 103-character address", () => {
    expect(CARDANO_103).toHaveLength(103);
    expect(ok("cardano", CARDANO_103)).toBe(CARDANO_103);
  });
});

describe("checkAddress in general", () => {
  it("rejects empty input, whitespace and non-strings", () => {
    expect(bad("eth", "")).toBe("empty");
    expect(bad("eth", "   ")).toBe("empty");
    expect(bad("eth", `${EVM.slice(0, 20)} ${EVM.slice(20)}`)).toBe("format");
    expect(bad("eth", null)).toBe("format");
    expect(bad("eth", 42)).toBe("format");
    expect(bad("eth", "x".repeat(300))).toBe("format");
  });

  it("trims surrounding whitespace", () => {
    expect(ok("eth", `  ${EVM}\n`)).toBe(EVM);
  });

  it("names the chain an address belongs to when it was pasted in the wrong field", () => {
    const wrong = (chain: string, address: string) => {
      const result = checkAddress(chain, address);
      return result.ok ? "accepted" : result.looksLike;
    };
    expect(wrong("sol", EVM)).toBe("Ethereum");
    expect(wrong("eth", SOL)).toBe("Solana");
    expect(wrong("eth", TRON)).toBe("Tron");
    expect(wrong("sol", "bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4")).toBe("Bitcoin");
    expect(wrong("eth", "GA5ZSEJYB37JRC5AVCIA5MOP4RHTM335X2KGX3IHOJAPP5RE34K4KZVN")).toBe("Stellar");
    expect(wrong("eth", "not an address")).toBeNull();
  });

  it("falls back to a shape check on an unknown chain", () => {
    expect(ok("newchain", "abcdefghijklmnopqrstuvwxyz012345")).toBeTruthy();
    expect(bad("newchain", "short")).toBe("format");
    expect(bad("newchain", "has<script>alert(1)</script>inside")).toBe("format");
  });

  it("compares EVM addresses without regard to case", () => {
    expect(sameAddress("eth", EVM, EVM.toLowerCase())).toBe(true);
    expect(sameAddress("sol", SOL, SOL.toLowerCase())).toBe(false);
  });
});

describe("preview stand-in addresses", () => {
  it("has a valid stand-in for every known chain", () => {
    for (const chain of CHAINS.keys()) {
      const address = placeholderFor(chain);
      expect(address, chain).not.toBeNull();
      expect(checkAddress(chain, address).ok, `${chain} ${address}`).toBe(true);
      expect(isPlaceholder(address!)).toBe(true);
    }
  });
  it("does not flag ordinary addresses", () => {
    expect(isPlaceholder(EVM)).toBe(false);
    expect(isPlaceholder(SOL)).toBe(false);
  });
  it("has none for an unknown chain", () => {
    expect(placeholderFor("newchain")).toBeNull();
  });
});

describe("transaction hashes", () => {
  it("checks shape per chain", () => {
    expect(isValidTxHash("eth", "0x" + "ab".repeat(32))).toBe(true);
    expect(isValidTxHash("eth", "ab".repeat(32))).toBe(false);
    expect(isValidTxHash("eth", "0x" + "ab".repeat(31))).toBe(false);
    expect(isValidTxHash("btc", "ab".repeat(32))).toBe(true);
    expect(isValidTxHash("sol", "5".repeat(88))).toBe(true);
    expect(isValidTxHash("sol", "0x" + "ab".repeat(32))).toBe(false);
    expect(isValidTxHash("eth", null)).toBe(false);
    expect(isValidTxHash("eth", "0x" + "ab".repeat(32) + "<")).toBe(false);
  });
});

describe("address spellings for screening", () => {
  it("links the two spellings of a Bitcoin Cash address", () => {
    const legacy = "1BpEi6DfDAUFd7GtittLSdBeYJvcoaVggu";
    const cash = "bitcoincash:qpm2qsznhks23z7629mms6s4cwef74vcwvy22gdx6a";
    expect(addressVariants(legacy)).toContain(cash);
    expect(addressVariants(cash)).toContain(legacy);
    expect(addressVariants(cash.slice("bitcoincash:".length))).toContain(legacy);
    expect(addressVariants("3CWFddi6m4ndiGyKqzYvsFYagqDLPVMTzC")).toContain("bitcoincash:ppm2qsznhks23z7629mms6s4cwef74vcwvn0h829pq");
  });
  it("links the two spellings of a Litecoin script address", () => {
    const variants = addressVariants("3CWFddi6m4ndiGyKqzYvsFYagqDLPVMTzC");
    const litecoin = variants.find((v) => v.startsWith("M"));
    expect(litecoin).toBeDefined();
    expect(addressVariants(litecoin!)).toContain("3CWFddi6m4ndiGyKqzYvsFYagqDLPVMTzC");
  });
  it("matches hex addresses with and without the 0x prefix", () => {
    const bare = EVM.slice(2).toLowerCase();
    expect(addressVariants(EVM).sort()).toEqual([EVM.toLowerCase(), bare].sort());
    expect(addressVariants(bare.toUpperCase())).toContain(EVM.toLowerCase());
    const long = "ab".repeat(32);
    expect(addressVariants(`0x${long}`)).toContain(long);
    expect(addressVariants(long)).toContain(`0x${long}`);
  });

  it("links every spelling of a TON address: bounceable or not, in either base64 alphabet", () => {
    const bounceable = "EQCxE6mUtQJKFnGfaROTKOt1lZbDiiX1kCixRv7Nw2Id_sDs";
    const variants = addressVariants(bounceable);
    expect(variants).toContain(bounceable);
    const nonBounceable = variants.find((v) => v.startsWith("UQ"));
    expect(nonBounceable).toBeDefined();
    expect(checkAddress("ton", nonBounceable).ok).toBe(true);
    expect(addressVariants(nonBounceable!)).toContain(bounceable);
    // The "+" and "/" alphabet spells the same bytes.
    const standard = bounceable.replace(/-/g, "+").replace(/_/g, "/");
    expect(standard).not.toBe(bounceable);
    expect(addressVariants(standard)).toContain(bounceable);
    expect(variants).toContain(standard);
    // Text that is not a TON address gains no TON spellings.
    expect(addressVariants(SOL)).toEqual([SOL]);
  });

  it("links a Starknet address written with and without leading zeros", () => {
    const padded = "0x033068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
    const trimmed = "0x33068f6539f8e6e6b131e6b2b814e6c34a5224bc66947c47dab9dfee93b35fb";
    expect(addressVariants(padded)).toContain(trimmed);
    expect(addressVariants(trimmed)).toContain(padded);
    expect(addressVariants(padded.toUpperCase().replace("0X", "0x"))).toContain(trimmed);
  });

  it("folds case for hex and bech32 only", () => {
    expect(addressVariants(EVM)).toContain(EVM.toLowerCase());
    expect(addressVariants("BC1QW508D6QEJXTDG4Y5R3ZARVARY0C5XW7KV8F3T4")).toEqual(["bc1qw508d6qejxtdg4y5r3zarvary0c5xw7kv8f3t4"]);
    expect(addressVariants(SOL)).toEqual([SOL]);
  });
});

describe("words for address problems", () => {
  const ERRORS = ["empty", "format", "checksum", "burn", "zcash_shielded", "xrp_tag", "stellar_muxed", "testnet"] as const;
  // One line under an address field holds about 60 characters on a wide screen. Every sentence must fit it,
  // on every chain, because the room for it is kept free and a longer one would push the page down.
  it("fit on one line with every chain's name", () => {
    for (const chain of CHAINS.keys()) {
      for (const error of ERRORS) {
        const text = addressMessage(chain, error, null);
        expect(text.length, `${chain} ${error}: ${text}`).toBeLessThanOrEqual(60);
      }
    }
  });

  it("name the chain and say what to do", () => {
    expect(addressMessage("sol", "format", null)).toBe("That is not a Solana address. Check it.");
    expect(addressMessage("eth", "checksum", null)).toBe("That Ethereum address has a typo. Check it.");
    expect(addressMessage("eth", "empty", null)).toBe("Enter an Ethereum address.");
    expect(addressMessage("sol", "format", "Ethereum")).toBe("This address is for Ethereum. Enter a Solana address.");
    expect(addressMessage("xrp", "xrp_tag", null)).toBe("This XRP address needs a tag, which isn't supported.");
  });
});
