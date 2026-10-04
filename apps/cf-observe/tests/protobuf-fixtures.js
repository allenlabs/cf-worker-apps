// Independent, minimal wire encoder for protocol tests (not production code).
const enc = new TextEncoder();
export const concat = (...xs) => Uint8Array.from(xs.flatMap(x => Array.from(x)));
export function varint(n) {
    let v = BigInt(n), out = [];
    do {
        let b = Number(v & 127n);
        v >>= 7n;
        if (v)
            b |= 128;
        out.push(b);
    } while (v);
    return Uint8Array.from(out);
}
export function message(tag, b) {
    return concat(varint(tag * 8 + 2), varint(b.length), b);
}
export function string(tag, s) {
    return message(tag, enc.encode(s));
}
export function fixed64(tag, n) {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, BigInt(n), true);
    return concat(varint(tag * 8 + 1), b);
}
export function encodeFixture(signal, stamp) {
    const record = concat(fixed64(1, stamp), message(5, string(1, 'binary log')));
    return message(1, message(2, message(2, record)));
}
