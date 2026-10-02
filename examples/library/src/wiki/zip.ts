/**
 * Minimal, standard uncompressed ZIP generator for browser, isolate, and Node environments.
 * Used to package the Obsidian vault for 1-click download.
 */

// CRC-32 lookup table
const crcTable = new Uint32Array(256);
for (let i = 0; i < 256; i++) {
	let c = i;
	for (let k = 0; k < 8; k++) {
		c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
	}
	crcTable[i] = c;
}

function crc32(data: Uint8Array): number {
	let crc = 0xffffffff;
	for (let i = 0; i < data.length; i++) {
		const byte = data[i] as number;
		crc = (crc >>> 8) ^ (crcTable[(crc ^ byte) & 0xff] as number);
	}
	return (crc ^ 0xffffffff) >>> 0;
}

export interface ZipEntry {
	name: string;
	data: Uint8Array | string;
	date?: Date;
}

export function createZip(entries: ZipEntry[]): Uint8Array {
	const textEncoder = new TextEncoder();
	const localHeaders: Uint8Array[] = [];
	const centralHeaders: Uint8Array[] = [];

	let offset = 0;

	for (const entry of entries) {
		const nameBytes = textEncoder.encode(entry.name);
		const dataBytes =
			typeof entry.data === 'string' ? textEncoder.encode(entry.data) : entry.data;

		const checksum = crc32(dataBytes);
		const size = dataBytes.length;

		const d = entry.date ?? new Date();
		const dosTime =
			((d.getHours() << 11) | (d.getMinutes() << 5) | (Math.floor(d.getSeconds() / 2))) & 0xffff;
		const dosDate =
			(((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()) & 0xffff;

		// Local file header (30 bytes + name + data)
		const localHeader = new Uint8Array(30 + nameBytes.length);
		const lv = new DataView(localHeader.buffer);
		lv.setUint32(0, 0x04034b50, true); // Local file header signature
		lv.setUint16(4, 20, true); // Version needed to extract (2.0)
		lv.setUint16(6, 0, true); // General purpose bit flag
		lv.setUint16(8, 0, true); // Compression method (0 = store)
		lv.setUint16(10, dosTime, true);
		lv.setUint16(12, dosDate, true);
		lv.setUint32(14, checksum, true);
		lv.setUint32(18, size, true); // Compressed size
		lv.setUint32(22, size, true); // Uncompressed size
		lv.setUint16(26, nameBytes.length, true);
		lv.setUint16(28, 0, true); // Extra field length
		localHeader.set(nameBytes, 30);

		localHeaders.push(localHeader, dataBytes);

		// Central directory header (46 bytes + name)
		const centralHeader = new Uint8Array(46 + nameBytes.length);
		const cv = new DataView(centralHeader.buffer);
		cv.setUint32(0, 0x02014b50, true); // Central directory header signature
		cv.setUint16(4, 20, true); // Version made by
		cv.setUint16(6, 20, true); // Version needed to extract
		cv.setUint16(8, 0, true); // General purpose bit flag
		cv.setUint16(10, 0, true); // Compression method
		cv.setUint16(12, dosTime, true);
		cv.setUint16(14, dosDate, true);
		cv.setUint32(16, checksum, true);
		cv.setUint32(20, size, true);
		cv.setUint32(24, size, true);
		cv.setUint16(28, nameBytes.length, true);
		cv.setUint16(30, 0, true); // Extra field length
		cv.setUint16(32, 0, true); // File comment length
		cv.setUint16(34, 0, true); // Disk number start
		cv.setUint16(36, 0, true); // Internal file attributes
		cv.setUint32(38, 0, true); // External file attributes
		cv.setUint32(42, offset, true); // Relative offset of local header
		centralHeader.set(nameBytes, 46);

		centralHeaders.push(centralHeader);

		offset += localHeader.length + dataBytes.length;
	}

	const centralDirOffset = offset;
	let centralDirSize = 0;
	for (const ch of centralHeaders) centralDirSize += ch.length;

	// End of central directory record (22 bytes)
	const endRecord = new Uint8Array(22);
	const ev = new DataView(endRecord.buffer);
	ev.setUint32(0, 0x06054b50, true); // End of central dir signature
	ev.setUint16(4, 0, true); // Number of this disk
	ev.setUint16(6, 0, true); // Disk where central directory starts
	ev.setUint16(8, entries.length, true); // Total entries in central directory on this disk
	ev.setUint16(10, entries.length, true); // Total entries in central directory
	ev.setUint32(12, centralDirSize, true); // Size of central directory
	ev.setUint32(16, centralDirOffset, true); // Offset of start of central directory
	ev.setUint16(20, 0, true); // Comment length

	const totalLength = centralDirOffset + centralDirSize + 22;
	const out = new Uint8Array(totalLength);
	let pos = 0;
	for (const chunk of localHeaders) {
		out.set(chunk, pos);
		pos += chunk.length;
	}
	for (const chunk of centralHeaders) {
		out.set(chunk, pos);
		pos += chunk.length;
	}
	out.set(endRecord, pos);

	return out;
}
