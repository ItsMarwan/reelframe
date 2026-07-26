/* ==========================================================================
   Music — lightweight ID3v2 tag reader (title / artist / album / cover art)
   Falls back gracefully (filename → title, folder → artist) for anything
   without readable tags, or formats we don't parse (only mp3/ID3v2 is read).
   ========================================================================== */
function readSyncsafeInt(bytes, offset){
  return ((bytes[offset] & 0x7f) << 21) | ((bytes[offset+1] & 0x7f) << 14) |
         ((bytes[offset+2] & 0x7f) << 7) | (bytes[offset+3] & 0x7f);
}
function decodeId3Text(bytes){
  if(!bytes.length) return '';
  const enc = bytes[0];
  const body = bytes.subarray(1);
  try{
    if(enc === 1) return new TextDecoder('utf-16').decode(body).replace(/\u0000+$/,'').trim();
    if(enc === 2) return new TextDecoder('utf-16be').decode(body).replace(/\u0000+$/,'').trim();
    if(enc === 3) return new TextDecoder('utf-8').decode(body).replace(/\u0000+$/,'').trim();
    return new TextDecoder('iso-8859-1').decode(body).replace(/\u0000+$/,'').trim();
  }catch(e){ return ''; }
}
async function parseId3Tags(item){
  const out = {};
  try{
    const head = new Uint8Array(await item.file.slice(0, 10).arrayBuffer());
    if(head[0] !== 0x49 || head[1] !== 0x44 || head[2] !== 0x33) return out; // not "ID3"
    const version = head[3];
    const tagSize = readSyncsafeInt(head, 6);
    const buf = new Uint8Array(await item.file.slice(0, 10 + tagSize).arrayBuffer());
    let pos = 10;
    const frameIdLen = version === 2 ? 3 : 4;
    while(pos < buf.length - frameIdLen - 3){
      let id, size;
      if(version === 2){
        id = String.fromCharCode(buf[pos], buf[pos+1], buf[pos+2]);
        size = (buf[pos+3] << 16) | (buf[pos+4] << 8) | buf[pos+5];
        pos += 6;
      } else {
        id = String.fromCharCode(buf[pos], buf[pos+1], buf[pos+2], buf[pos+3]);
        size = version >= 4 ? readSyncsafeInt(buf, pos+4) : (buf[pos+4]<<24)|(buf[pos+5]<<16)|(buf[pos+6]<<8)|buf[pos+7];
        pos += 10;
      }
      if(!id.trim() || size <= 0 || pos + size > buf.length) break;
      const frame = buf.subarray(pos, pos + size);
      if(id === 'TIT2' || id === 'TT2') out.title = decodeId3Text(frame);
      else if(id === 'TPE1' || id === 'TP1') out.artist = decodeId3Text(frame);
      else if(id === 'TALB' || id === 'TAL') out.album = decodeId3Text(frame);
      else if(id === 'APIC' || id === 'PIC'){
        try{
          let p = 1; // skip text-encoding byte
          let mime = 'image/jpeg';
          if(id === 'APIC'){
            let end = p; while(end < frame.length && frame[end] !== 0) end++;
            mime = new TextDecoder('iso-8859-1').decode(frame.subarray(p, end)) || 'image/jpeg';
            p = end + 1 + 1; // skip null + picture-type byte
          } else {
            mime = 'image/' + (new TextDecoder('iso-8859-1').decode(frame.subarray(p, p+3)).toLowerCase() === 'png' ? 'png' : 'jpeg');
            p += 3 + 1;
          }
          const enc = frame[0];
          if(enc === 1 || enc === 2){
            while(p < frame.length - 1 && !(frame[p] === 0 && frame[p+1] === 0)) p += 2;
            p += 2;
          } else {
            while(p < frame.length && frame[p] !== 0) p++;
            p += 1;
          }
          const imgBytes = frame.subarray(p);
          if(imgBytes.length > 100){
            out.cover = URL.createObjectURL(new Blob([imgBytes], { type: mime }));
          }
        }catch(e){ /* skip malformed picture frame */ }
      }
      pos += size;
    }
  }catch(e){ /* not a readable/tagged file — fall back to filename */ }
  return out;
}

function fallbackTitle(item){
  return item.name.replace(/\.[^.]+$/, '').replace(/[_\-]+/g, ' ').trim() || item.name;
}
function trackTitle(item){ return item.title || fallbackTitle(item); }
function trackArtist(item){ return item.artist || item.category; }

/* Cheap deterministic "color" for the fallback cover tile, so tracks without
   embedded art still look distinct from one another at a glance. */
function coverFallbackHue(item){
  let h = 0;
  for(let i = 0; i < item.path.length; i++) h = (h * 31 + item.path.charCodeAt(i)) >>> 0;
  return h % 360;
}
function coverArtHTML(item, size){
  if(item.cover) return `<img src="${item.cover}" alt="">`;
  const hue = coverFallbackHue(item);
  return `<div class="cover-fallback" style="background: linear-gradient(135deg, hsl(${hue},55%,32%), hsl(${(hue+40)%360},50%,18%));">
    <svg width="${Math.round(size*0.42)}" height="${Math.round(size*0.42)}" viewBox="0 0 24 24" fill="none"><path d="M9 18V5l11-2v13" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round"/><circle cx="6" cy="18" r="3" stroke="currentColor" stroke-width="1.7"/><circle cx="17" cy="16" r="3" stroke="currentColor" stroke-width="1.7"/></svg>
  </div>`;
}

function ensureAudioMeta(item){
  if(item._metaPromise) return item._metaPromise;
  item._metaPromise = (async () => {
    const tags = await parseId3Tags(item);
    if(tags.title) item.title = tags.title;
    if(tags.artist) item.artist = tags.artist;
    if(tags.album) item.album = tags.album;
    if(tags.cover) item.cover = tags.cover;
    const src = ensureItemUrl(item);
    if(!src){ return item; }
    await new Promise((resolve) => {
      const a = document.createElement('audio');
      a.preload = 'metadata';
      a.src = src;
      a.addEventListener('loadedmetadata', () => { item.duration = a.duration; resolve(); });
      a.addEventListener('error', () => { item.broken = true; resolve(); });
      setTimeout(resolve, 5000);
    });
    return item;
  })();
  return item._metaPromise;
}

