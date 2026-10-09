// A minimal writer for the MaxMind DB file format (version 2.0, IPv4 tree,
// 32-bit records). It exists so tests can run the real region-lookup code
// against a real-format database without shipping a 120 MB file.

type Value = string | number | bigint | boolean | Value[] | { [key: string]: Value };

function control(type: number, size: number): Buffer {
  let sizeBits = size;
  let extra: number[] = [];
  if (size >= 285) {
    sizeBits = 30;
    extra = [(size - 285) >> 8, (size - 285) & 0xff];
  } else if (size >= 29) {
    sizeBits = 29;
    extra = [size - 29];
  }
  // Types above 7 are "extended": the type bits are zero and the real type follows in the next byte.
  return type <= 7 ? Buffer.from([(type << 5) | sizeBits, ...extra]) : Buffer.from([sizeBits, type - 7, ...extra]);
}

function unsigned(value: bigint, maxBytes: number): Buffer {
  const bytes: number[] = [];
  for (let v = value; v > 0n; v >>= 8n) bytes.unshift(Number(v & 0xffn));
  if (bytes.length > maxBytes) throw new RangeError("number too large");
  return Buffer.from(bytes);
}

function encode(value: Value): Buffer {
  if (typeof value === "string") {
    const text = Buffer.from(value, "utf8");
    return Buffer.concat([control(2, text.length), text]);
  }
  if (typeof value === "number") {
    const bytes = unsigned(BigInt(value), 4);
    return Buffer.concat([control(6, bytes.length), bytes]);
  }
  if (typeof value === "bigint") {
    const bytes = unsigned(value, 8);
    return Buffer.concat([control(9, bytes.length), bytes]);
  }
  if (typeof value === "boolean") return control(14, value ? 1 : 0);
  if (Array.isArray(value)) return Buffer.concat([control(11, value.length), ...value.map(encode)]);
  const entries = Object.entries(value);
  return Buffer.concat([control(7, entries.length), ...entries.flatMap(([key, item]) => [encode(key), encode(item)])]);
}

interface TrieNode {
  children: [TrieNode | number | null, TrieNode | number | null];
}

function bitsOf(cidr: string): number[] {
  const [address = "", prefix = "32"] = cidr.split("/");
  const octets = address.split(".").map(Number);
  const bits: number[] = [];
  for (const octet of octets) for (let i = 7; i >= 0; i--) bits.push((octet >> i) & 1);
  return bits.slice(0, Number(prefix));
}

/** Builds a database file from `{ "a.b.c.d/len": record }`. */
export function buildMmdb(networks: Record<string, Value>, databaseType = "Test-City"): Buffer {
  const data: Buffer[] = [];
  let dataLength = 0;
  const root: TrieNode = { children: [null, null] };

  for (const [cidr, record] of Object.entries(networks)) {
    const offset = dataLength;
    const encoded = encode(record);
    data.push(encoded);
    dataLength += encoded.length;
    const bits = bitsOf(cidr);
    let node = root;
    bits.forEach((bit, i) => {
      const side = bit as 0 | 1;
      if (i === bits.length - 1) {
        node.children[side] = offset;
        return;
      }
      let next = node.children[side];
      if (next === null || typeof next === "number") {
        next = { children: [null, null] };
        node.children[side] = next;
      }
      node = next;
    });
  }

  // Number the nodes breadth-first, then write each as two 32-bit records.
  const nodes: TrieNode[] = [root];
  for (let i = 0; i < nodes.length; i++) {
    for (const child of nodes[i]!.children) if (child !== null && typeof child !== "number") nodes.push(child);
  }
  const index = new Map(nodes.map((node, i) => [node, i]));
  const tree = Buffer.alloc(nodes.length * 8);
  nodes.forEach((node, i) => {
    node.children.forEach((child, side) => {
      // Below the node count: another node. Equal: nothing here. Above: a data offset.
      const record = child === null ? nodes.length : typeof child === "number" ? nodes.length + 16 + child : index.get(child)!;
      tree.writeUInt32BE(record, i * 8 + side * 4);
    });
  });

  const metadata = encode({
    binary_format_major_version: 2,
    binary_format_minor_version: 0,
    build_epoch: 1_790_000_000n,
    database_type: databaseType,
    description: { en: "Test database" },
    ip_version: 4,
    languages: ["en"],
    node_count: nodes.length,
    record_size: 32,
  });

  return Buffer.concat([tree, Buffer.alloc(16), ...data, Buffer.from([0xab, 0xcd, 0xef]), Buffer.from("MaxMind.com", "latin1"), metadata]);
}
