export function readVarint(bytes, state) {
  let value = 0n;
  let shift = 0n;
  while (state.offset < bytes.length) {
    const byte = bytes[state.offset++];
    value |= BigInt(byte & 0x7f) << shift;
    if ((byte & 0x80) === 0) return value;
    shift += 7n;
    if (shift > 70n) throw new Error("Invalid protobuf varint");
  }
  throw new Error("Truncated protobuf varint");
}

export function parseFields(input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input);
  const fields = [];
  const state = { offset: 0 };

  while (state.offset < bytes.length) {
    const key = readVarint(bytes, state);
    const number = Number(key >> 3n);
    const wire = Number(key & 7n);
    if (!number) throw new Error("Invalid protobuf field number 0");

    if (wire === 0) {
      fields.push({ number, wire, value: readVarint(bytes, state) });
    } else if (wire === 1) {
      if (state.offset + 8 > bytes.length) throw new Error("Truncated fixed64");
      const value = bytes.slice(state.offset, state.offset + 8);
      state.offset += 8;
      fields.push({ number, wire, value });
    } else if (wire === 2) {
      const length = Number(readVarint(bytes, state));
      if (!Number.isSafeInteger(length) || length < 0 || state.offset + length > bytes.length) {
        throw new Error("Invalid protobuf length-delimited field");
      }
      const value = bytes.slice(state.offset, state.offset + length);
      state.offset += length;
      fields.push({ number, wire, value });
    } else if (wire === 5) {
      if (state.offset + 4 > bytes.length) throw new Error("Truncated fixed32");
      const value = bytes.slice(state.offset, state.offset + 4);
      state.offset += 4;
      fields.push({ number, wire, value });
    } else {
      throw new Error(`Unsupported protobuf wire type ${wire}`);
    }
  }
  return fields;
}

export const first = (fields, number) => fields.find(field => field.number === number);
export const all = (fields, number) => fields.filter(field => field.number === number);
export const asNumber = field => {
  if (!field || field.wire !== 0) return 0;
  const value = Number(field.value);
  return Number.isFinite(value) ? value : 0;
};

export const asString = field => {
  if (!field || field.wire !== 2) return "";
  const value = field.value;
  if (!(value instanceof Uint8Array) && !ArrayBuffer.isView(value) && !(value instanceof ArrayBuffer)) return "";
  return new TextDecoder().decode(value);
};

export const asId = field => {
  if (!field) return "";
  if (field.wire === 0) return String(field.value);
  if (field.wire === 2 && field.value instanceof Uint8Array) {
    return new TextDecoder().decode(field.value);
  }
  return "";
};

export const asMessage = field => {
  if (!field || field.wire !== 2 || !(field.value instanceof Uint8Array)) return [];
  return parseFields(field.value);
};
