/**
 * Writes PDFs the way scanners write them, so the reader of scanned PDFs is tested against files it did not make: a page that is one
 * picture drawn over the whole of it, in the encodings and with the drawing tricks that scanners use. Written from the PDF format's
 * description and apart from the reader.
 */

import { deflateSync } from "node:zlib";

import type { GreyImage } from "../../src/sheets/image.ts";

export type Encoding =
  | "flate"
  | "raw"
  | "flate-predictor"
  | "rgb"
  | "icc-gray"
  | "indexed-1"
  | "mask"
  | "mask-swapped"
  | "decode-inverted"
  | "cmyk"
  | "jpeg"
  | "jpeg-wrapped"
  | "indexed-1-reversed"
  | "rgb-tint"
  | "lab"
  | "ccitt"
  | "jbig2"
  | "jpx"
  | "lzw";

export interface Picture {
  image: GreyImage;
  encoding: Encoding;
  /** Bytes to use as a JPEG, for the "jpeg" encoding. */
  jpeg?: Uint8Array;
  /** Cut the data short, so the picture is damaged. */
  cut?: boolean;
  /** Written in the dictionary as the width and height, whatever the image has. */
  claimSize?: [number, number];
  /** Layers: a soft mask, or a mask. */
  smask?: boolean;
  /** Extra dictionary text. */
  extra?: string;
}

export interface PageSpec {
  picture?: Picture;
  /** More pictures on the page, drawn after the first (strips, layers, a logo). Each has its own place on the page, in points: x, y, width, height. */
  more?: Array<{ picture: Picture; at: [number, number, number, number] }>;
  /** The page's Rotate. */
  rotate?: number;
  /** The matrix the picture is drawn by, if it is not to fill the page. */
  matrix?: [number, number, number, number, number, number];
  /** The size of the page in points, if it is not the size of the picture at 72 to the inch scaled by `points`. */
  size?: [number, number];
  /** Draw the picture from inside a form. */
  form?: boolean;
  /** The form's own matrix. */
  formMatrix?: number[];
  /** An inline picture instead of an XObject. */
  inline?: boolean;
  /** An invisible text layer, as character recognition adds. */
  text?: boolean;
  /** Points to a pixel. Default 0.36, which is 200 dots to the inch. */
  points?: number;
}

const ascii = (s: string): Buffer => Buffer.from(s, "latin1");

function bytesOf(p: Picture): { dict: string; data: Buffer; filter: string } {
  const { image } = p;
  const { width, height } = image;
  const w = p.claimSize?.[0] ?? width;
  const h = p.claimSize?.[1] ?? height;
  const base = `/Type /XObject /Subtype /Image /Width ${w} /Height ${h}`;
  const finish = (dict: string, data: Buffer, filter: string): { dict: string; data: Buffer; filter: string } => ({ dict: `${base} ${dict} ${p.smask ? "/SMask 99 0 R" : ""} ${p.extra ?? ""}`, data: p.cut ? data.subarray(0, Math.floor(data.length / 2)) : data, filter });
  const gray = Buffer.from(image.data);
  switch (p.encoding) {
    case "raw":
      return finish("/ColorSpace /DeviceGray /BitsPerComponent 8", gray, "");
    case "flate":
      return finish("/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode", deflateSync(gray), "FlateDecode");
    case "flate-predictor": {
      // PNG "up" prediction, as many scanners' PDFs use: each row is the difference from the one above, with a tag byte in front.
      const rows = Buffer.alloc((width + 1) * height);
      for (let y = 0; y < height; y++) {
        rows[y * (width + 1)] = 2;
        for (let x = 0; x < width; x++) rows[y * (width + 1) + 1 + x] = ((image.data[y * width + x] as number) - (y > 0 ? (image.data[(y - 1) * width + x] as number) : 0)) & 0xff;
      }
      return finish(`/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode /DecodeParms << /Predictor 12 /Columns ${width} /Colors 1 /BitsPerComponent 8 >>`, deflateSync(rows), "FlateDecode");
    }
    case "rgb": {
      const rgb = Buffer.alloc(width * height * 3);
      for (let i = 0; i < width * height; i++) rgb.fill(image.data[i] as number, i * 3, i * 3 + 3);
      return finish("/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode", deflateSync(rgb), "FlateDecode");
    }
    case "cmyk": {
      // grey as black ink only: cyan, magenta and yellow zero, key the dark of it
      const cmyk = Buffer.alloc(width * height * 4);
      for (let i = 0; i < width * height; i++) cmyk[i * 4 + 3] = 255 - (image.data[i] as number);
      return finish("/ColorSpace /DeviceCMYK /BitsPerComponent 8 /Filter /FlateDecode", deflateSync(cmyk), "FlateDecode");
    }
    case "icc-gray":
      return finish("/ColorSpace [/ICCBased 98 0 R] /BitsPerComponent 8 /Filter /FlateDecode", deflateSync(gray), "FlateDecode");
    case "decode-inverted":
      return finish("/ColorSpace /DeviceGray /BitsPerComponent 8 /Decode [1 0] /Filter /FlateDecode", deflateSync(Buffer.from(image.data.map((v) => 255 - v))), "FlateDecode");
    case "indexed-1":
    case "mask":
    case "mask-swapped": {
      const stride = Math.ceil(width / 8);
      const bits = Buffer.alloc(stride * height);
      for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
          const white = (image.data[y * width + x] as number) >= 128;
          // Indexed: 1 is white. A stencil paints where its sample is 0 (black ink is 0), or where it is 1 when the decode setting is swapped.
          const bit = p.encoding === "mask-swapped" ? (white ? 0 : 1) : white ? 1 : 0;
          if (bit) bits[y * stride + (x >> 3)] = (bits[y * stride + (x >> 3)] as number) | (0x80 >> (x & 7));
        }
      }
      if (p.encoding === "indexed-1") return finish("/ColorSpace [/Indexed /DeviceRGB 1 <000000FFFFFF>] /BitsPerComponent 1 /Filter /FlateDecode", deflateSync(bits), "FlateDecode");
      return finish(`/ImageMask true /BitsPerComponent 1 ${p.encoding === "mask-swapped" ? "/Decode [1 0]" : ""} /Filter /FlateDecode`, deflateSync(bits), "FlateDecode");
    }
    case "jpeg":
      return finish("/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /DCTDecode", Buffer.from(p.jpeg ?? new Uint8Array([0xff, 0xd8, 0xff, 0xd9])), "DCTDecode");
    case "jpeg-wrapped":
      return finish("/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter [/FlateDecode /DCTDecode]", deflateSync(Buffer.from(p.jpeg ?? new Uint8Array([0xff, 0xd8, 0xff, 0xd9]))), "FlateDecode");
    case "rgb-tint": {
      // red and green at the grey, no blue: a yellow-ish scan
      const rgb = Buffer.alloc(width * height * 3);
      for (let i = 0; i < width * height; i++) {
        rgb[i * 3] = image.data[i] as number;
        rgb[i * 3 + 1] = image.data[i] as number;
      }
      return finish("/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode", deflateSync(rgb), "FlateDecode");
    }
    case "lab":
      return finish("/ColorSpace [/Lab << /WhitePoint [0.95 1 1.09] >>] /BitsPerComponent 8 /Filter /FlateDecode", deflateSync(Buffer.alloc(width * height * 3, 100)), "FlateDecode");
    case "indexed-1-reversed": {
      // a palette with white first and black second, so that an index is not the grey it stands for
      const stride = Math.ceil(width / 8);
      const bits = Buffer.alloc(stride * height);
      for (let y = 0; y < height; y++) for (let x = 0; x < width; x++) if ((image.data[y * width + x] as number) < 128) bits[y * stride + (x >> 3)] = (bits[y * stride + (x >> 3)] as number) | (0x80 >> (x & 7));
      return finish("/ColorSpace [/Indexed /DeviceRGB 1 <FFFFFF000000>] /BitsPerComponent 1 /Filter /FlateDecode", deflateSync(bits), "FlateDecode");
    }
    case "ccitt":
      return finish(`/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /CCITTFaxDecode /DecodeParms << /K -1 /Columns ${width} >>`, Buffer.from("garbage"), "CCITTFaxDecode");
    case "jbig2":
      return finish("/ColorSpace /DeviceGray /BitsPerComponent 1 /Filter /JBIG2Decode", Buffer.from("garbage"), "JBIG2Decode");
    case "jpx":
      return finish("/Filter /JPXDecode", Buffer.from("garbage"), "JPXDecode");
    case "lzw":
      return finish("/ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /LZWDecode", Buffer.from("garbage"), "LZWDecode");
  }
}

/** A PDF of pages, each a scan. */
export function scanPdf(pages: PageSpec[], more: { encrypt?: boolean; trailerOnly?: boolean } = {}): Uint8Array {
  const objects: Buffer[] = [];
  const add = (body: Buffer): number => {
    objects.push(body);
    return objects.length;
  };
  const stream = (dict: string, data: Buffer): Buffer => Buffer.concat([ascii(`<< ${dict} /Length ${data.length} >>\nstream\n`), data, ascii("\nendstream")]);
  // 1 catalog, 2 pages, 98 a colour profile, 99 a mask: reserved numbers are filled in after the pages so that the numbering is simple
  add(Buffer.alloc(0));
  add(Buffer.alloc(0));
  const pageIds: number[] = [];
  for (const spec of pages) {
    const pts = spec.points ?? 0.36;
    const first = spec.picture;
    const [pw, ph] = spec.size ?? (first ? [first.image.width * pts, first.image.height * pts] : [612, 792]);
    const resources: string[] = [];
    let content = "";
    const draw = (pic: Picture, name: string, m: string): void => {
      const { dict, data } = bytesOf(pic);
      const id = add(stream(dict, data));
      resources.push(`/${name} ${id} 0 R`);
      content += `q ${m} cm /${name} Do Q\n`;
    };
    if (first) {
      const m = spec.matrix ?? [pw, 0, 0, ph, 0, 0];
      if (spec.inline) {
        const body = Buffer.concat([ascii(`q ${m.join(" ")} cm BI /W 8 /H 8 /CS /G /BPC 8 ID `), Buffer.alloc(64, 128), ascii("\nEI Q\n")]);
        const cid = add(stream("", body));
        const pid = add(ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] ${spec.rotate ? `/Rotate ${spec.rotate}` : ""} /Contents ${cid} 0 R /Resources << >> >>`));
        pageIds.push(pid);
        continue;
      }
      if (spec.form) {
        const { dict, data } = bytesOf(first);
        const imageId = add(stream(dict, data));
        const formId = add(stream(`/Type /XObject /Subtype /Form /BBox [0 0 ${pw} ${ph}] ${spec.formMatrix ? `/Matrix [${spec.formMatrix.join(" ")}]` : ""} /Resources << /XObject << /Im0 ${imageId} 0 R >> >>`, ascii("q 1 0 0 1 0 0 cm /Im0 Do Q")));
        resources.push(`/Fm0 ${formId} 0 R`);
        content += `q ${m.join(" ")} cm /Fm0 Do Q\n`;
      } else draw(first, "Im0", m.join(" "));
    }
    (spec.more ?? []).forEach((extra, i) => draw(extra.picture, `Im${i + 1}`, `${extra.at[2]} 0 0 ${extra.at[3]} ${extra.at[0]} ${extra.at[1]}`));
    if (spec.text) content += "BT /F1 12 Tf 3 Tr 10 10 Td (Question 1) Tj ET\n";
    const cid = add(stream("", ascii(content)));
    const pid = add(ascii(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pw} ${ph}] ${spec.rotate ? `/Rotate ${spec.rotate}` : ""} /Contents ${cid} 0 R /Resources << /XObject << ${resources.join(" ")} >> ${spec.text ? "/Font << /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica >> >>" : ""} >> >>`));
    pageIds.push(pid);
  }
  objects[0] = ascii("<< /Type /Catalog /Pages 2 0 R >>");
  objects[1] = ascii(`<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(" ")}] /Count ${pageIds.length} >>`);
  // numbers 98 and 99 are referred to by some pictures: pad the table out to them
  if (objects.length > 97) throw new Error("A test PDF this large would run into the numbers kept for the colour profile and the mask.");
  while (objects.length < 99) objects.push(ascii("null"));
  objects[97] = stream("/N 1", Buffer.alloc(0));
  objects[98] = stream("/Type /XObject /Subtype /Image /Width 1 /Height 1 /ColorSpace /DeviceGray /BitsPerComponent 8", Buffer.from([255]));

  const parts: Buffer[] = [ascii("%PDF-1.4\n%\xE2\xE3\xCF\xD3\n")];
  const offsets: number[] = [];
  let length = parts[0]!.length;
  objects.forEach((body, i) => {
    offsets.push(length);
    const chunk = Buffer.concat([ascii(`${i + 1} 0 obj\n`), body, ascii("\nendobj\n")]);
    parts.push(chunk);
    length += chunk.length;
  });
  const xref = length;
  let table = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const o of offsets) table += `${String(o).padStart(10, "0")} 00000 n \n`;
  parts.push(ascii(`${table}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R ${more.encrypt ? "/Encrypt << /Filter /Standard >>" : ""} >>\nstartxref\n${xref}\n%%EOF\n`));
  return new Uint8Array(Buffer.concat(parts));
}
