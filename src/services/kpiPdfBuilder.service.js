"use strict";
/**
 * kpi-pdf-builder.js  — CONTINUOUS FLOW VERSION
 * Sections no longer force new pages; content flows naturally and only
 * breaks when it genuinely doesn't fit in the remaining space.
 * Colors and header follow the AVOCarbon charter (src/config/brand.js).
 */

const fs = require("fs");
const zlib = require("zlib");
const { BRAND, STATUS, LOGO_PATH } = require("../config/brand");

// ─── PDF low-level writer ────────────────────────────────────────────────────
class PDFWriter {
  constructor() {
    this.parts    = [];
    this.offsets  = [];
    this.objCount = 0;
    this.pageIds  = [];
    this.pageContentIds = [];
    this._pos = 0;
    this._write("%PDF-1.4\n%\xFF\xFF\xFF\xFF\n");
  }

  _write(str) {
    const buf = Buffer.from(str, "latin1");
    this.parts.push(buf);
    this._pos += buf.length;
  }
  _writeBuf(buf) { this.parts.push(buf); this._pos += buf.length; }

  _startObj() {
    this.objCount++;
    this.offsets.push(this._pos);
    this._write(`${this.objCount} 0 obj\n`);
    return this.objCount;
  }
  _endObj() { this._write("endobj\n"); }

  writeCatalog(pagesId) {
    const id = this._startObj();
    this._write(`<< /Type /Catalog /Pages ${pagesId} 0 R >>\n`);
    this._endObj();
    return id;
  }
  writeInfo(title, author) {
    const id = this._startObj();
    this._write(`<< /Title (${title}) /Author (${author}) /Producer (AVOCarbon KPI System) >>\n`);
    this._endObj();
    return id;
  }
  writePages(pageIds) {
    const id = this._startObj();
    const kids = pageIds.map(i => `${i} 0 R`).join(" ");
    this._write(`<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length}\n   /MediaBox [0 0 595.28 841.89] >>\n`);
    this._endObj();
    return id;
  }
  writePage(pagesId, contentId, resourcesId) {
    const id = this._startObj();
    this._write(
      `<< /Type /Page /Parent ${pagesId} 0 R\n` +
      `   /Contents ${contentId} 0 R\n` +
      `   /Resources ${resourcesId} 0 R >>\n`
    );
    this._endObj();
    return id;
  }
  writeResources(logoImageId = null) {
    const id = this._startObj();
    this._write(
      `<< /Font <<\n` +
      `   /F1 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\n` +
      `   /F2 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold /Encoding /WinAnsiEncoding >>\n` +
      `   /F3 << /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Oblique /Encoding /WinAnsiEncoding >>\n` +
      `>>\n` +
      (logoImageId ? `   /XObject << /Logo ${logoImageId} 0 R >>\n` : "") +
      `>>\n`
    );
    this._endObj();
    return id;
  }
  /** RGB image XObject; `data` is the zlib-compressed pixel rows. */
  writeImage({ width, height, data }) {
    const id = this._startObj();
    this._write(
      `<< /Type /XObject /Subtype /Image /Width ${width} /Height ${height}\n` +
      `   /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode /Length ${data.length} >>\nstream\n`
    );
    this._writeBuf(data);
    this._write("\nendstream\n");
    this._endObj();
    return id;
  }
  writeStream(streamStr) {
    const id = this._startObj();
    const buf = Buffer.from(streamStr, "latin1");
    this._write(`<< /Length ${buf.length} >>\nstream\n`);
    this._writeBuf(buf);
    this._write("\nendstream\n");
    this._endObj();
    return id;
  }
  finish(catalogId, infoId) {
    const xrefPos = this._pos;
    this._write(`xref\n0 ${this.objCount + 1}\n`);
    this._write("0000000000 65535 f \n");
    for (const off of this.offsets) {
      this._write(String(off).padStart(10, "0") + " 00000 n \n");
    }
    this._write(
      `trailer\n<< /Size ${this.objCount + 1} /Root ${catalogId} 0 R /Info ${infoId} 0 R >>\n` +
      `startxref\n${xrefPos}\n%%EOF\n`
    );
    return Buffer.concat(this.parts);
  }
}

// ─── Colour helper ───────────────────────────────────────────────────────────
function hex2rgb(hex) {
  const h = hex.replace("#", "");
  return [parseInt(h.slice(0,2),16)/255, parseInt(h.slice(2,4),16)/255, parseInt(h.slice(4,6),16)/255];
}
function rgbCmd(hex) {
  const [r,g,b] = hex2rgb(hex);
  return `${r.toFixed(3)} ${g.toFixed(3)} ${b.toFixed(3)}`;
}

// ─── Logo ────────────────────────────────────────────────────────────────────
// The charter logo (8-bit RGBA or RGB PNG, not interlaced) decoded once into
// RGB rows flattened on white -- it is only drawn on the white page. null when
// it cannot be read: the header then falls back to a text wordmark.
let logoImageCache;
function loadLogoImage() {
  if (logoImageCache !== undefined) return logoImageCache;
  logoImageCache = null;
  try {
    const png = fs.readFileSync(LOGO_PATH);
    let width = 0, height = 0, depth = 0, colorType = 0, interlace = 0;
    const idat = [];
    for (let off = 8; off + 8 <= png.length;) {
      const len = png.readUInt32BE(off);
      const type = png.toString("latin1", off + 4, off + 8);
      const chunk = png.subarray(off + 8, off + 8 + len);
      if (type === "IHDR") {
        width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4);
        depth = chunk[8]; colorType = chunk[9]; interlace = chunk[12];
      } else if (type === "IDAT") idat.push(chunk);
      else if (type === "IEND") break;
      off += 12 + len;
    }
    if (!width || !height || depth !== 8 || interlace !== 0 || (colorType !== 6 && colorType !== 2)) {
      return logoImageCache;
    }

    const bpp = colorType === 6 ? 4 : 3;
    const stride = width * bpp;
    const raw = zlib.inflateSync(Buffer.concat(idat));
    if (raw.length < height * (stride + 1)) return logoImageCache;

    const rgb = Buffer.alloc(width * height * 3);
    let prev = Buffer.alloc(stride);
    for (let y = 0; y < height; y++) {
      const filter = raw[y * (stride + 1)];
      const line = Buffer.from(raw.subarray(y * (stride + 1) + 1, (y + 1) * (stride + 1)));
      // Undo the PNG row filter (None, Sub, Up, Average, Paeth).
      for (let i = 0; i < stride; i++) {
        const a = i >= bpp ? line[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
        let p = 0;
        if (filter === 1) p = a;
        else if (filter === 2) p = b;
        else if (filter === 3) p = (a + b) >> 1;
        else if (filter === 4) {
          const pa = Math.abs(b - c), pb = Math.abs(a - c), pc = Math.abs(a + b - 2 * c);
          p = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
        }
        line[i] = (line[i] + p) & 0xff;
      }
      for (let x = 0; x < width; x++) {
        const alpha = bpp === 4 ? line[x * 4 + 3] / 255 : 1;
        for (let ch = 0; ch < 3; ch++) {
          rgb[(y * width + x) * 3 + ch] = Math.round(line[x * bpp + ch] * alpha + 255 * (1 - alpha));
        }
      }
      prev = line;
    }
    logoImageCache = { width, height, data: zlib.deflateSync(rgb) };
  } catch (err) {
    console.warn("[KPI PDF] Logo unavailable, using the text wordmark:", err.message);
    logoImageCache = null;
  }
  return logoImageCache;
}

const CHAR_WIDTHS = {
  normal: {
    default:278," ":278,"!":278,'"':355,"#":556,"$":556,"%":889,"&":667,"'":191,
    "(":333,")":333,"*":389,"+":584,",":278,"-":333,".":278,"/":278,
    "0":556,"1":556,"2":556,"3":556,"4":556,"5":556,"6":556,"7":556,"8":556,"9":556,
    ":":278,";":278,"<":584,"=":584,">":584,"?":556,"@":1015,
    "A":667,"B":667,"C":722,"D":722,"E":667,"F":611,"G":778,"H":722,"I":278,
    "J":500,"K":667,"L":611,"M":833,"N":722,"O":778,"P":667,"Q":778,"R":722,
    "S":667,"T":611,"U":722,"V":667,"W":944,"X":667,"Y":667,"Z":611,
    "[":278,"\\":278,"]":278,"^":469,"_":556,"`":333,
    "a":556,"b":556,"c":500,"d":556,"e":556,"f":278,"g":556,"h":556,"i":222,
    "j":222,"k":500,"l":222,"m":833,"n":556,"o":556,"p":556,"q":556,"r":333,
    "s":500,"t":278,"u":556,"v":500,"w":722,"x":500,"y":500,"z":500,
  },
  bold: {
    default:278," ":278,
    "A":722,"B":722,"C":722,"D":778,"E":667,"F":611,"G":778,"H":722,"I":278,
    "J":556,"K":722,"L":611,"M":833,"N":722,"O":778,"P":667,"Q":778,"R":722,
    "S":667,"T":611,"U":722,"V":667,"W":944,"X":667,"Y":667,"Z":611,
    "a":556,"b":611,"c":556,"d":611,"e":556,"f":333,"g":611,"h":611,"i":278,
    "j":278,"k":556,"l":278,"m":889,"n":611,"o":611,"p":611,"q":611,"r":389,
    "s":556,"t":333,"u":611,"v":556,"w":778,"x":556,"y":556,"z":500,
    "0":556,"1":556,"2":556,"3":556,"4":556,"5":556,"6":556,"7":556,"8":556,"9":556,
    ".":278,",":278,":":333,";":333,"-":333,"(":333,")":333,"/":278,"%":889,
  }
};
function charWidth(ch, bold) {
  const map = bold ? CHAR_WIDTHS.bold : CHAR_WIDTHS.normal;
  return (map[ch] ?? map.default) / 1000;
}
function textWidth(text, fontSize, bold=false) {
  let w=0; for (const ch of text) w += charWidth(ch,bold)*fontSize; return w;
}
function sanitize(str) {
  if (!str) return "";
  return String(str)
    .replace(/[\u2018\u2019]/g,"'").replace(/[\u201C\u201D]/g,'"')
    .replace(/\u2013/g,"-").replace(/\u2014/g,"--")
    .replace(/\u2022/g,"*").replace(/[^\x09\x0A\x0D\x20-\xFF]/g,"");
}

// ─── Page canvas ──────────────────────────────────────────────────────────────
class Page {
  constructor(w=595.28, h=841.89) {
    this.W=w; this.H=h; this.ops=[];
    this._font=null; this._fontSize=12;
    this._fillColor="0 0 0"; this._strokeColor="0 0 0";
  }
  setFill(hex)   { const c=rgbCmd(hex); if(c!==this._fillColor)   {this.ops.push(`${c} rg`);  this._fillColor=c;  } }
  setStroke(hex) { const c=rgbCmd(hex); if(c!==this._strokeColor) {this.ops.push(`${c} RG`);  this._strokeColor=c;} }
  setFont(bold,size) {
    const f=bold?"F2":"F1";
    if(f!==this._font||size!==this._fontSize){this.ops.push(`/${f} ${size} Tf`);this._font=f;this._fontSize=size;}
  }
  setLineWidth(w) { this.ops.push(`${w} w`); }
  rect(x,y,w,h,fillHex) {
    this.setFill(fillHex);
    this.ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re f`);
  }
  rectStroke(x,y,w,h,strokeHex,lw=0.5) {
    this.setStroke(strokeHex); this.setLineWidth(lw);
    this.ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re S`);
  }
  rectFillStroke(x,y,w,h,fillHex,strokeHex,lw=0.5) {
    this.setFill(fillHex); this.setStroke(strokeHex); this.setLineWidth(lw);
    this.ops.push(`${x.toFixed(2)} ${y.toFixed(2)} ${w.toFixed(2)} ${h.toFixed(2)} re B`);
  }
  image(name,x,y,w,h) {
    this.ops.push(`q ${w.toFixed(2)} 0 0 ${h.toFixed(2)} ${x.toFixed(2)} ${y.toFixed(2)} cm /${name} Do Q`);
  }
  hline(x,y,w,strokeHex,lw=0.5) {
    this.setStroke(strokeHex); this.setLineWidth(lw);
    this.ops.push(`${x.toFixed(2)} ${y.toFixed(2)} m ${(x+w).toFixed(2)} ${y.toFixed(2)} l S`);
  }
  text(str,x,y,fontSize,bold,colorHex) {
    const s=sanitize(str); if(!s) return;
    this.setFill(colorHex); this.setFont(bold,fontSize);
    const esc=s.replace(/\\/g,"\\\\").replace(/\(/g,"\\(").replace(/\)/g,"\\)");
    this.ops.push(`BT ${x.toFixed(2)} ${y.toFixed(2)} Td (${esc}) Tj ET`);
  }
  textCenter(str,x,y,w,fontSize,bold,colorHex) {
    const s=sanitize(str);
    const tw=textWidth(s,fontSize,bold);
    this.text(s, x+(w-tw)/2, y, fontSize, bold, colorHex);
  }
  textRight(str,x,y,w,fontSize,bold,colorHex) {
    const s=sanitize(str);
    const tw=textWidth(s,fontSize,bold);
    this.text(s, x+w-tw, y, fontSize, bold, colorHex);
  }
  stream() { return this.ops.join("\n"); }
}

// ─── Text helpers ─────────────────────────────────────────────────────────────
function wrapText(text, maxWidth, fontSize, bold=false) {
  const words=sanitize(text).split(/\s+/).filter(Boolean);
  const lines=[]; let cur="";
  for (const word of words) {
    const test=cur?cur+" "+word:word;
    if (textWidth(test,fontSize,bold)<=maxWidth) { cur=test; }
    else { if(cur) lines.push(cur); cur=word; }
  }
  if(cur) lines.push(cur);
  return lines;
}
function drawWrapped(page,text,x,y,maxWidth,fontSize,bold,colorHex,lineH) {
  const lines=wrapText(text,maxWidth,fontSize,bold);
  for (const line of lines) { page.text(line,x,y,fontSize,bold,colorHex); y-=lineH; }
  return y;
}
function wrappedHeight(text,maxWidth,fontSize,bold,lineH) {
  return wrapText(text,maxWidth,fontSize,bold).length*lineH;
}

// ─── Constants ────────────────────────────────────────────────────────────────
const PW=595.28, PH=841.89;
const ML=36, MR=36, MT=36, MB=48;
const CW=PW-ML-MR;

// AVOCarbon charter: AVO blue primary, GROUP orange as accent only (bars),
// neutral grays for text and lines. Status colors keep their meaning and use
// the darker *Text shades, readable as text and under white badge labels.
const C = {
  blue:BRAND.blue,       darkBlue:BRAND.blueDark,     lightBlue:BRAND.blueTint,
  orange:BRAND.orange,   orangeText:BRAND.orangeText, lightOrange:BRAND.orangeTint, orangeSoft:BRAND.orangeSoft,
  green:STATUS.goodText,     lightGreen:STATUS.goodTint,     greenSoft:STATUS.goodSoft,
  red:STATUS.criticalText,   lightRed:STATUS.criticalTint,   redSoft:STATUS.criticalSoft,
  amber:STATUS.warningText,  lightAmber:STATUS.warningTint,  amberSoft:STATUS.warningSoft,
  gray:BRAND.muted,      lightGray:BRAND.panel,  carbon:BRAND.gray,
  border:BRAND.line,     darkText:BRAND.ink,
  midText:BRAND.text,    softText:BRAND.muted,
  white:BRAND.white,
};

function statusInfo(value, lowLimit) {
  try {
    const v=parseFloat(value); if(isNaN(v)) return {label:"No Data",color:C.gray,bg:C.lightGray,border:C.border};
    const ll=parseFloat(lowLimit);
    if(!isNaN(ll)){
      if(v<ll)        return {label:"Below Limit",color:C.red,  bg:C.lightRed,  border:C.redSoft  };
      if(v<ll*1.10)   return {label:"Near Limit", color:C.amber,bg:C.lightAmber,border:C.amberSoft};
    }
    return {label:"On Track",color:C.green,bg:C.lightGreen,border:C.greenSoft};
  } catch { return {label:"No Data",color:C.gray,bg:C.lightGray,border:C.border}; }
}

// Brand bar: AVO blue ending in a GROUP orange segment (as under the e-mail header).
function drawBrandBar(page, x, y, w, h) {
  page.rect(x, y, w*0.84, h, C.blue);
  page.rect(x + w*0.84, y, w*0.16, h, C.orange);
}

function fmtVal(v,unit="") {
  if(v===null||v===undefined||String(v).trim()===""||String(v)==="None") return "N/A";
  const n=parseFloat(v); if(isNaN(n)) return String(v);
  const s=Number.isInteger(n)?String(n):n.toFixed(2);
  return unit?`${s} ${unit}`:s;
}

// ─── Document state — shared mutable context ─────────────────────────────────
class DocState {
  constructor(week, responsible) {
    this.week        = week;
    this.responsible = responsible;
    this.pages       = [];
    this.page        = new Page();
    this.cursor      = MT;   // distance from top of page
  }

  /** Available vertical space on current page */
  avail() { return PH - this.cursor - MB; }

  /** PDF y coordinate for the current cursor */
  y() { return PH - this.cursor; }

  /** Advance cursor by `delta` pixels */
  advance(delta) { this.cursor += delta; }

  /**
   * Ensure at least `needed` pixels remain on the current page.
   * If not, seal the current page and start a fresh one.
   */
  need(needed) {
    if (this.avail() < needed) {
      this.newPage();
    }
  }

  newPage() {
    this.pages.push(this.page);
    this.page   = new Page();
    this.cursor = MT;
  }

  finish() {
    this.pages.push(this.page);
    return this.pages;
  }
}

// ─── Page decorator ───────────────────────────────────────────────────────────
function decoratePage(page, pageNum, totalPages, week, responsible) {
  // Page 1 opens with the logo header and its own brand bar (buildCover).
  if (pageNum > 1) drawBrandBar(page, 0, PH-4, PW, 4);
  page.rect(0, 0, PW, MB-4, C.lightGray);
  page.hline(0, MB-4, PW, C.border, 0.5);
  page.text("AVOCarbon Group - KPI Recommendation Report - Confidential", ML, 13, 7, false, C.softText);
  page.textRight(`Page ${pageNum} of ${totalPages}`, ML, 13, CW, 7, false, C.softText);
  page.textCenter(
    `${sanitize(responsible.name)}  |  ${sanitize(responsible.plant_name)}  |  ${week.replace("2026-Week","Week ")}`,
    ML, 22, CW, 7, false, C.softText);
}

// ─── Section heading (inline — no page break forced) ─────────────────────────
function sectionHead(ds, title) {
  ds.need(36);
  ds.advance(6);
  ds.page.text(title, ML, ds.y(), 14, true, C.blue);
  ds.advance(18);
  ds.page.hline(ML, ds.y(), CW, C.blue, 1.5);
  ds.advance(10);
}

// ─── Cover block (compact — fits in ~190px) ──────────────────────────────────
function buildCover(ds, data) {
  // Brand header: logo (text wordmark if the image is unavailable) on the
  // left, product label on the right, brand bar underneath.
  const logoH = 24;
  ds.need(logoH + 150);
  const top = ds.y();
  if (ds.logo) {
    ds.page.image("Logo", ML, top-logoH, logoH*ds.logo.width/ds.logo.height, logoH);
  } else {
    ds.page.text("AVOCarbon Group", ML, top-18, 16, true, C.blue);
  }
  ds.page.textRight("KPI MANAGER", ML, top-15, CW, 8, true, C.carbon);
  ds.advance(logoH + 12);
  drawBrandBar(ds.page, ML, ds.y()-3, CW, 3);
  ds.advance(3 + 22);

  // Title block (was a blue banner): eyebrow, title, then who / where / when.
  ds.page.text("AI-POWERED STRATEGIC RECOMMENDATIONS", ML, ds.y(), 8, true, C.blue);
  ds.advance(26);
  ds.page.text("KPI Performance Report", ML, ds.y(), 22, true, C.darkText);
  ds.advance(18);
  ds.page.text(
    `${sanitize(data.responsible.name)}  |  ${sanitize(data.responsible.plant_name)}  |  ${data.week.replace("2026-Week","Week ")}`,
    ML, ds.y(), 10, false, C.softText);
  ds.advance(16);

  // Meta cards row
  const cardW = CW/4, cardH = 52;
  ds.need(cardH + 12);
  const metaItems = [
    { label:"GENERATED",  value: new Date().toLocaleDateString("en-GB",{day:"2-digit",month:"short",year:"numeric"}) },
    { label:"DEPARTMENT", value: data.responsible.department_name || "N/A" },
    { label:"TOTAL KPIs", value: String(data.kpis.length) },
    { label:"CRITICAL",   value: String(data.kpis.filter(k=>k.status==="Below Limit").length) },
  ];
  metaItems.forEach((item, i) => {
    const cx  = ML + i*cardW;
    const cy  = ds.y() - cardH;
    ds.page.rectFillStroke(cx, cy, cardW, cardH, i%2===0?C.lightGray:C.white, C.border, 0.5);
    ds.page.textCenter(item.label, cx, cy+cardH-14, cardW, 7, true, C.softText);
    ds.page.textCenter(sanitize(item.value), cx, cy+12, cardW, 13, true,
      item.label==="CRITICAL"&&parseInt(item.value)>0 ? C.red : C.darkText);
  });
  ds.advance(cardH + 14);

  // Thin separator before the next section
  ds.page.hline(ML, ds.y(), CW, C.border, 0.5);
  ds.advance(10);
}

// ─── Summary table ────────────────────────────────────────────────────────────
function buildSummaryTable(ds, data) {
  sectionHead(ds, "KPI Performance Summary");

  const cols   = [CW*0.40, CW*0.14, CW*0.13, CW*0.13, CW*0.20];
  const headers= ["KPI Indicator","Current","Low Limit","High Limit","Status"];
  const rowH   = 26, hdrH = 20;
  const xs     = cols.reduce((acc,w,i)=>{ acc.push((acc[i]||ML)+w); return acc; }, [ML]);

  function drawHeader() {
    ds.need(hdrH);
    ds.page.rect(ML, ds.y()-hdrH, CW, hdrH, C.blue);
    let cx=ML;
    headers.forEach((h,i)=>{
      ds.page.textCenter(h, cx+2, ds.y()-hdrH+6, cols[i]-4, 8, true, C.white);
      cx+=cols[i];
    });
    ds.advance(hdrH);
  }

  drawHeader();

  data.kpis.forEach((kpi, idx) => {
    if (ds.avail() < rowH) { ds.newPage(); drawHeader(); }

    const si  = statusInfo(kpi.value, kpi.low_limit);
    const bg  = idx%2===0 ? C.white : C.lightGray;
    const rowY = ds.y() - rowH;

    ds.page.rect(ML, rowY, CW, rowH, bg);
    ds.page.rectStroke(ML, rowY, CW, rowH, C.border, 0.3);

    const nameLines = wrapText(
      sanitize(kpi.indicator_title || kpi.indicator_sub_title || "Untitled KPI"),
      cols[0]-8,
      8,
      false
    );
    const nameY = rowY + rowH - 11;
    nameLines.slice(0,2).forEach((ln,li)=>{
      ds.page.text(ln, ML+4, nameY-li*10, 8, false, C.darkText);
    });
    if(kpi.indicator_sub_title){
      ds.page.text(sanitize(kpi.indicator_sub_title).substring(0,40), ML+4, nameY-20, 7, false, C.softText);
    }

    const unit=kpi.unit||"";
    [fmtVal(kpi.value,unit), fmtVal(kpi.low_limit,unit), fmtVal(kpi.high_limit,unit)].forEach((val,ci)=>{
      ds.page.textCenter(val, xs[ci+1]+2, rowY+rowH/2-4, cols[ci+1]-4, 9, false, C.midText);
    });

    const bW=80, bH=14, bX=xs[4]+4, bY=rowY+(rowH-bH)/2;
    ds.page.rect(bX, bY, bW, bH, si.color);
    ds.page.textCenter(si.label, bX, bY+3, bW, 8, true, C.white);

    ds.advance(rowH);
  });

  ds.advance(10);
}

// ─── Recommendations ──────────────────────────────────────────────────────────
function buildRecommendations(ds, data) {
  const recs = data.recommendations||[];
  if(!recs.length) return;

  // separator + heading
  ds.need(20); ds.page.hline(ML, ds.y(), CW, C.border, 0.5); ds.advance(8);
  sectionHead(ds, "AI-Powered Recommendations");

  const intro="The following recommendations were generated by AI after analysing each KPI's current performance, historical trend, and distance from target limits.";
  const introLines=wrapText(intro, CW, 9, false);
  ds.need(introLines.length*13+6);
  introLines.forEach(ln=>{ ds.page.text(ln, ML, ds.y(), 9, false, C.midText); ds.advance(13); });
  ds.advance(6);

  // Card colors are brand, not status: neutral panels with an AVO blue
  // accent; "Immediate Actions" (this week) gets the GROUP orange accent.
  const sections=[
    {key:"root_cause",       label:"Root Cause Analysis",fill:C.lightGray,  border:C.border,    accent:C.blue,   labelColor:C.darkBlue  },
    {key:"immediate_actions",label:"Immediate Actions",  fill:C.lightOrange,border:C.orangeSoft,accent:C.orange, labelColor:C.orangeText},
    {key:"medium_term_plan", label:"Medium-Term Plan",   fill:C.lightGray,  border:C.border,    accent:C.blue,   labelColor:C.darkBlue  },
    {key:"evidence_metrics", label:"Evidence & Metrics", fill:C.lightGray,  border:C.border,    accent:C.blue,   labelColor:C.darkBlue  },
    {key:"risk_mitigation",  label:"Risk Mitigation",    fill:C.lightGray,  border:C.border,    accent:C.blue,   labelColor:C.darkBlue  },
  ];

  recs.forEach((rec, recIdx) => {
    const si   = statusInfo(rec.current_value, rec.low_limit);
    const unit = rec.unit||"";

    // KPI title bar
    const titleH=22;
    ds.need(titleH + 42);
    const tY=ds.y()-titleH;
    ds.page.rectFillStroke(ML, tY, CW, titleH, si.bg, si.border, 0.8);
    ds.page.text(`${recIdx+1}. ${sanitize(rec.kpi_name)}`, ML+8, tY+7, 11, true, C.darkText);
    const bW2=82, bH2=13;
    ds.page.rect(ML+CW-bW2-6, tY+4, bW2, bH2, si.color);
    ds.page.textCenter(si.label, ML+CW-bW2-6, tY+5, bW2, 8, true, C.white);
    ds.advance(titleH+2);

    if(rec.kpi_subtitle){
      ds.need(12);
      ds.page.text(sanitize(rec.kpi_subtitle), ML+4, ds.y(), 8, false, C.softText);
      ds.advance(12);
    }
    // Responsible tag
    if(rec.responsible_name){
      ds.need(12);
      ds.page.text(`Responsible: ${sanitize(rec.responsible_name)}`, ML+4, ds.y(), 8, false, C.softText);
      ds.advance(12);
    }

    // Stats row
    const statW=CW/4, statH=32;
    ds.need(statH+4);
    const statLabels=["CURRENT VALUE","LOW LIMIT","HIGH LIMIT","TARGET"];
    const statVals  =[fmtVal(rec.current_value,unit),fmtVal(rec.low_limit,unit),fmtVal(rec.high_limit,unit),fmtVal(rec.target,unit)];
    // Only the current value carries a status; limits and target are plain values.
    const statColors=[si.color, C.darkText, C.darkText, C.darkText];
    statLabels.forEach((lbl,i)=>{
      const sx=ML+i*statW, sy=ds.y()-statH;
      ds.page.rectFillStroke(sx, sy, statW, statH, i%2===0?C.lightGray:C.white, C.border, 0.3);
      ds.page.textCenter(lbl, sx, sy+statH-11, statW, 7, true, C.softText);
      ds.page.textCenter(sanitize(statVals[i]), sx, sy+7, statW, 10, true, statColors[i]);
    });
    ds.advance(statH+4);

    // Recommendation cards
    sections.forEach(({key,label,fill,border,accent,labelColor})=>{
      const txt=(rec[key]||"").trim(); if(!txt) return;
      const cardLines=wrapText(sanitize(txt), CW-18, 9, false);
      const cardH=14+cardLines.length*13+8;
      ds.need(cardH+2);
      const cy=ds.y()-cardH;
      ds.page.rect(ML+3, cy, CW-3, cardH, fill);
      ds.page.rectStroke(ML, cy, CW, cardH, border, 0.4);
      ds.page.rect(ML, cy, 3, cardH, accent);
      ds.page.text(label, ML+9, cy+cardH-12, 9, true, labelColor);
      cardLines.forEach((ln,li)=>{
        ds.page.text(ln, ML+9, cy+cardH-24-li*13, 9, false, C.midText);
      });
      ds.advance(cardH+3);
    });

    ds.advance(8);
  });
}

// ─── Strategic overview ───────────────────────────────────────────────────────
function buildStrategicOverview(ds, data) {
  const overview  = (data.strategic_overview||"").trim();
  const nextSteps = data.next_steps||[];
  if(!overview&&!nextSteps.length) return;

  ds.need(20); ds.page.hline(ML, ds.y(), CW, C.border, 0.5); ds.advance(8);
  sectionHead(ds, "Strategic Overview & Next Steps");

  if(overview){
    const lines=wrapText(sanitize(overview), CW, 9, false);
    ds.need(lines.length*13+6);
    lines.forEach(ln=>{ ds.page.text(ln, ML, ds.y(), 9, false, C.midText); ds.advance(13); });
    ds.advance(8);
  }

  if(nextSteps.length){
    ds.need(20);
    ds.page.text("Recommended Next Steps", ML, ds.y(), 11, true, C.darkText);
    ds.advance(16);

    nextSteps.forEach((step,i)=>{
      const stepLines=wrapText(`${i+1}.  ${sanitize(step)}`, CW-12, 9, false);
      const blockH=stepLines.length*13+8;
      ds.need(blockH);
      const by=ds.y()-blockH;
      ds.page.rect(ML, by, CW, blockH, i%2===0?C.lightGray:C.white);
      ds.page.rect(ML, by, 3, blockH, C.blue);
      stepLines.forEach((ln,li)=>{
        ds.page.text(ln, ML+9, ds.y()-9-li*13, 9, li===0, C.midText);
      });
      ds.advance(blockH+2);
    });
    ds.advance(10);
  }

  // Priority matrix
  const matW=CW/3, matH=72;
  ds.need(matH+16);
  ds.page.text("Performance Summary Matrix", ML, ds.y(), 11, true, C.darkText);
  ds.advance(14);

  const critical=data.kpis.filter(k=>k.status==="Below Limit").length;
  const watch   =data.kpis.filter(k=>k.status==="Near Limit").length;
  const good    =data.kpis.length-critical-watch;
  const matCols=[
    {label:"CRITICAL",value:critical,fill:C.lightRed,   stroke:C.redSoft,   color:C.red,   desc:"Below low limit"},
    {label:"WATCH",   value:watch,   fill:C.lightAmber, stroke:C.amberSoft, color:C.amber, desc:"Near low limit" },
    {label:"ON TRACK",value:good,    fill:C.lightGreen, stroke:C.greenSoft, color:C.green, desc:"Above low limit"},
  ];
  const matY=ds.y()-matH;
  matCols.forEach((col,i)=>{
    const mx=ML+i*matW;
    ds.page.rectFillStroke(mx, matY, matW, matH, col.fill, col.stroke, 0.4);
    ds.page.textCenter(col.label, mx, matY+matH-13, matW, 9, true, col.color);
    ds.page.textCenter(String(col.value), mx, matY+28,    matW, 26, true, col.color);
    ds.page.textCenter(col.desc,         mx, matY+8,      matW, 7, false, C.softText);
  });
  ds.advance(matH+6);
}

// ─── Main export ──────────────────────────────────────────────────────────────
function generateKPIPdf(data) {
  const writer = new PDFWriter();
  const logo = loadLogoImage();
  const logoImageId = logo ? writer.writeImage(logo) : null;
  const resourcesId = writer.writeResources(logoImageId);

  // Build all content into DocState (continuous flow)
  const ds = new DocState(data.week, data.responsible);
  ds.logo = logoImageId ? logo : null;

  buildCover(ds, data);
  buildSummaryTable(ds, data);
  buildRecommendations(ds, data);
  buildStrategicOverview(ds, data);

  const pages      = ds.finish();
  const totalPages = pages.length;

  // Reserve pages object slot
  const pagesDummy = ++writer.objCount;
  writer.offsets.push(0);

  // Write content streams
  const contentIds = [];
  pages.forEach((pg, idx) => {
    decoratePage(pg, idx+1, totalPages, data.week, data.responsible);
    contentIds.push(writer.writeStream(pg.stream()));
  });

  // Write page objects
  const pageIds = [];
  pages.forEach((_, idx) => {
    pageIds.push(writer.writePage(pagesDummy, contentIds[idx], resourcesId));
  });

  // Fix pages dict
  const pagesOffset = writer._pos;
  writer.offsets[pagesDummy-1] = pagesOffset;
  const kids = pageIds.map(i=>`${i} 0 R`).join(" ");
  writer._write(
    `${pagesDummy} 0 obj\n` +
    `<< /Type /Pages /Kids [${kids}] /Count ${pageIds.length}\n` +
    `   /MediaBox [0 0 595.28 841.89] >>\n` +
    `endobj\n`
  );

  const infoId    = writer.writeInfo("KPI Recommendations Report","AVOCarbon KPI System");
  const catalogId = writer.writeCatalog(pagesDummy);

  return writer.finish(catalogId, infoId);
}

module.exports = { generateKPIPdf };
