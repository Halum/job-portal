// The photo arrives as PNG or JPEG bytes the upload route already sniffed. Its size is read from the header here, before
// pdfmake decodes any pixels: a tiny file can declare a huge picture, and decoding one costs gigabytes of memory.
export const MAX_PHOTO_SIDE = 4000;

export interface PhotoInfo {
  type: 'png' | 'jpeg';
  width: number;
  height: number;
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

function readHeader(photo: Buffer): PhotoInfo | null {
  if (
    photo.length >= 24 &&
    photo.subarray(0, 8).equals(PNG_SIGNATURE) &&
    photo.toString('latin1', 12, 16) === 'IHDR'
  ) {
    return { type: 'png', width: photo.readUInt32BE(16), height: photo.readUInt32BE(20) };
  }
  if (photo.length >= 4 && photo[0] === 0xff && photo[1] === 0xd8) {
    let at = 2;
    while (at + 4 <= photo.length) {
      if (photo[at] !== 0xff) return null;
      const marker = photo[at + 1] ?? 0;
      if (marker === 0xff) {
        at += 1;
        continue;
      }
      // Start-of-frame markers carry the size; C4, C8 and CC share the range but do not.
      if (
        marker >= 0xc0 &&
        marker <= 0xcf &&
        marker !== 0xc4 &&
        marker !== 0xc8 &&
        marker !== 0xcc
      ) {
        if (at + 9 > photo.length) return null;
        return {
          type: 'jpeg',
          height: photo.readUInt16BE(at + 5),
          width: photo.readUInt16BE(at + 7),
        };
      }
      at += 2 + photo.readUInt16BE(at + 2);
    }
  }
  return null;
}

export function checkPhoto(photo: Buffer): PhotoInfo {
  const info = readHeader(photo);
  if (!info) throw new Error('The photo must be a PNG or JPEG');
  if (
    info.width < 1 ||
    info.height < 1 ||
    info.width > MAX_PHOTO_SIDE ||
    info.height > MAX_PHOTO_SIDE
  ) {
    throw new Error(
      `The photo is too large: ${String(info.width)}x${String(info.height)} pixels, at most ${String(MAX_PHOTO_SIDE)} per side`,
    );
  }
  return info;
}
