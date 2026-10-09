// Some chains write the same destination in more than one way. Sanctions
// screening checks every spelling, so a listed address cannot be re-encoded
// to slip past.

import { sha256 } from "@noble/hashes/sha2";
import { base64, base64url, createBase58check } from "@scure/base";

const b58check = createBase58check(sha256);
const CHARSET = "qpzry9x8gf2tvdw0s3jn54khce6mua7l";
const GENERATORS = [0x98f2bc8e61n, 0x79b76d99e2n, 0xf33e5fb3c4n, 0xae2eabe2a8n, 0x1e4f43e470n];
const CASH_PREFIX = "bitcoincash";

function polymod(values: number[]): bigint {
  let c = 1n;
  for (const d of values) {
    const top = c >> 35n;
    c = ((c & 0x07ffffffffn) << 5n) ^ BigInt(d);
    GENERATORS.forEach((g, i) => {
      if ((top >> BigInt(i)) & 1n) c ^= g;
    });
  }
  return c ^ 1n;
}

function regroup(data: number[], from: number, to: number, pad: boolean): number[] | null {
  let acc = 0;
  let bits = 0;
  const out: number[] = [];
  const mask = (1 << to) - 1;
  for (const value of data) {
    acc = (acc << from) | value;
    bits += from;
    while (bits >= to) {
      bits -= to;
      out.push((acc >> bits) & mask);
    }
  }
  if (pad) {
    if (bits > 0) out.push((acc << (to - bits)) & mask);
  } else if (bits >= from || ((acc << (to - bits)) & mask) !== 0) {
    return null;
  }
  return out;
}

function cashEncode(versionByte: number, hash: Uint8Array): string {
  const payload = regroup([versionByte, ...hash], 8, 5, true) ?? [];
  const prefix = [...CASH_PREFIX].map((c) => c.charCodeAt(0) & 0x1f);
  const mod = polymod([...prefix, 0, ...payload, 0, 0, 0, 0, 0, 0, 0, 0]);
  const checksum: number[] = [];
  for (let i = 0; i < 8; i++) checksum.push(Number((mod >> BigInt(5 * (7 - i))) & 31n));
  return `${CASH_PREFIX}:${[...payload, ...checksum].map((v) => CHARSET[v]).join("")}`;
}

function cashDecode(address: string): { versionByte: number; hash: Uint8Array } | null {
  const lower = address.toLowerCase();
  const body = lower.startsWith(`${CASH_PREFIX}:`) ? lower.slice(CASH_PREFIX.length + 1) : lower;
  if (!/^[qp][qpzry9x8gf2tvdw0s3jn54khce6mua7l]{41}$/.test(body)) return null;
  const values = [...body].map((c) => CHARSET.indexOf(c));
  const prefix = [...CASH_PREFIX].map((c) => c.charCodeAt(0) & 0x1f);
  if (polymod([...prefix, 0, ...values]) !== 0n) return null;
  const bytes = regroup(values.slice(0, -8), 5, 8, false);
  if (bytes === null || bytes.length !== 21) return null;
  return { versionByte: bytes[0] ?? 0, hash: Uint8Array.from(bytes.slice(1)) };
}

function legacyDecode(address: string): { version: number; hash: Uint8Array } | null {
  if (!/^[1-9A-HJ-NP-Za-km-z]{25,36}$/.test(address)) return null;
  try {
    const bytes = b58check.decode(address);
    if (bytes.length !== 21) return null;
    return { version: bytes[0] ?? 0, hash: bytes.subarray(1) };
  } catch {
    return null;
  }
}

function legacyEncode(version: number, hash: Uint8Array): string {
  return b58check.encode(Uint8Array.from([version, ...hash]));
}

function crc16(data: Uint8Array): number {
  let crc = 0;
  for (const byte of data) {
    crc ^= byte << 8;
    for (let i = 0; i < 8; i++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc;
}

/** Every user-friendly spelling of a TON address, or nothing when the text is not one. */
function tonSpellings(address: string): string[] {
  if (!/^[A-Za-z0-9+/_-]{48}$/.test(address)) return [];
  let bytes: Uint8Array;
  try {
    bytes = base64url.decode(address.replace(/\+/g, "-").replace(/\//g, "_"));
  } catch {
    return [];
  }
  if (bytes.length !== 36 || (bytes[0] !== 0x11 && bytes[0] !== 0x51)) return [];
  const crc = crc16(bytes.subarray(0, 34));
  if (bytes[34] !== crc >> 8 || bytes[35] !== (crc & 0xff)) return [];
  const out: string[] = [];
  for (const tag of [0x11, 0x51]) {
    const body = Uint8Array.from([tag, ...bytes.subarray(1, 34)]);
    const sum = crc16(body);
    const full = Uint8Array.from([...body, sum >> 8, sum & 0xff]);
    out.push(base64url.encode(full), base64.encode(full));
  }
  return out;
}

/** Folds case where the format is case-insensitive, so lookups are exact string matches. */
export function canonical(address: string): string {
  const text = address.trim();
  if (/^0x[0-9a-fA-F]+$/.test(text)) return text.toLowerCase();
  if (/^(bc1|ltc1|bitcoincash:|addr1|aleo1)/i.test(text)) return text.toLowerCase();
  return text;
}

/** Every spelling of an address that should be treated as the same destination. */
export function addressVariants(address: string): string[] {
  const text = address.trim();
  const base = canonical(address);
  const out = new Set<string>([base]);

  // Hex addresses are written with and without the "0x" prefix; both spell the same account.
  if (/^0x([0-9a-f]{40}|[0-9a-f]{64})$/.test(base)) out.add(base.slice(2));
  if (/^([0-9a-fA-F]{40}|[0-9a-fA-F]{64})$/.test(base)) {
    out.add(base.toLowerCase());
    out.add(`0x${base.toLowerCase()}`);
  }

  const cash = cashDecode(base);
  if (cash) {
    out.add(cashEncode(cash.versionByte, cash.hash));
    out.add(cashEncode(cash.versionByte, cash.hash).slice(CASH_PREFIX.length + 1));
    if (cash.versionByte === 0) out.add(legacyEncode(0x00, cash.hash));
    if (cash.versionByte === 8) out.add(legacyEncode(0x05, cash.hash));
  }

  // Starknet writes the same address with or without leading zeros.
  if (/^0x[0-9a-f]{50,64}$/.test(base)) {
    const digits = base.slice(2).replace(/^0+/, "");
    out.add(`0x${digits}`);
    out.add(`0x${digits.padStart(64, "0")}`);
    out.add(`0x${digits.padStart(63, "0")}`);
  }

  // TON writes one account four ways: bounceable or not, in either base64 alphabet.
  for (const spelling of tonSpellings(text)) out.add(spelling);

  const legacy = legacyDecode(base);
  if (legacy) {
    // Bitcoin-format P2PKH / P2SH also spell Bitcoin Cash destinations.
    if (legacy.version === 0x00 || legacy.version === 0x05) {
      const encoded = cashEncode(legacy.version === 0x00 ? 0 : 8, legacy.hash);
      out.add(encoded);
      out.add(encoded.slice(CASH_PREFIX.length + 1));
    }
    // Litecoin P2SH has an old ("3…") and a new ("M…") spelling.
    if (legacy.version === 0x05) out.add(legacyEncode(0x32, legacy.hash));
    if (legacy.version === 0x32) out.add(legacyEncode(0x05, legacy.hash));
  }

  return [...out];
}
