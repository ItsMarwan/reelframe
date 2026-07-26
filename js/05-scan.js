/* ==========================================================================
   Directory scanning
   ========================================================================== */

/* Cheap first pass — walks the tree counting files that match a supported
   extension, without ever calling getFile() (which is the expensive part).
   Used only to know the total up front so the loading screen can show real
   "X of Y" progress instead of a bar that never moves. */
async function countScanEntries(rootHandle){
  let count = 0;
  async function walk(dirHandle){
    for await (const [name, handle] of dirHandle.entries()){
      if(name.startsWith('.')) continue;
      if(handle.kind === 'directory'){
        await walk(handle);
      } else if(handle.kind === 'file'){
        const ext = extOf(name);
        if(VIDEO_EXT.includes(ext) || IMAGE_EXT.includes(ext) || AUDIO_EXT.includes(ext)) count++;
      }
    }
  }
  await walk(rootHandle);
  return count;
}

/* `onProgress`, if given, is called with:
     { phase: 'counting' }
     { phase: 'reading', processed, total, name }
   Progress callbacks are throttled to roughly every 60ms (plus always on
   the very last file) so a huge library doesn't spam DOM writes. */
async function scanDirectory(rootHandle, onProgress){
  const videos = [];
  const images = [];
  const audio = [];

  if(onProgress) onProgress({ phase: 'counting' });
  const total = onProgress ? await countScanEntries(rootHandle) : 0;
  if(onProgress) onProgress({ phase: 'reading', processed: 0, total, name: '' });

  let processed = 0;
  let lastUpdate = 0;

  async function walk(dirHandle, pathParts, topCategory){
    for await (const [name, handle] of dirHandle.entries()){
      if(name.startsWith('.')) continue;
      if(handle.kind === 'directory'){
        const nextTop = topCategory || name;
        await walk(handle, [...pathParts, name], nextTop);
      } else if(handle.kind === 'file'){
        const ext = extOf(name);
        const isVideo = VIDEO_EXT.includes(ext);
        const isImage = IMAGE_EXT.includes(ext);
        const isAudio = !isVideo && !isImage && AUDIO_EXT.includes(ext);
        if(!isVideo && !isImage && !isAudio) continue;
        let file;
        try{ file = await handle.getFile(); }catch(e){ continue; }
        if(file.size === 0) continue; // empty/corrupt placeholder — not worth listing

        processed++;
        if(onProgress){
          const now = performance.now();
          if(now - lastUpdate > 60 || processed >= total){
            lastUpdate = now;
            onProgress({ phase: 'reading', processed, total, name });
          }
        }

        const item = {
          name,
          path: [...pathParts, name].join('/'),
          folderPath: pathParts.slice(),
          category: topCategory || UNCATEGORIZED,
          type: isVideo ? 'video' : isImage ? 'image' : 'audio',
          handle,
          file,
          url: null,
          size: file.size,
          lastModified: file.lastModified,
          ext,
          _rand: Math.random(),
          duration: null,
          thumb: null,
          broken: false,
        };
        if(isAudio){
          item.title = null;
          item.artist = null;
          item.album = null;
          item.cover = null;
        }
        if(isVideo) videos.push(item);
        else if(isImage) images.push(item);
        else audio.push(item);
      }
    }
  }

  await walk(rootHandle, [], null);
  return { videos, images, audio };
}