import { parseRenderLibrary, serializeRenderLibrary, type RenderLibrary } from '../domain/renderJobs'

/** Atomic read/validate/mutate/write; no successful publication before commit. */
export function renderTransaction<T>(key: 'jobs' | 'presets', parse: (value: unknown) => T, change?: (records: readonly T[]) => readonly T[]): Promise<RenderLibrary<T>> {
  return new Promise((resolve,reject)=>{
    if (typeof indexedDB === 'undefined') { reject(new Error('Local render storage is unavailable.')); return }
    const request=indexedDB.open('myrelith-render-jobs',1)
    request.onupgradeneeded=()=>request.result.createObjectStore('libraries')
    request.onerror=()=>reject(request.error)
    let blocked=false
    request.onblocked=()=>{blocked=true;reject(new Error('Another tab is blocking render storage.'))}
    request.onsuccess=()=>{
      const db=request.result
      if(blocked){db.close();return}
      db.onversionchange=()=>db.close()
      let tx: IDBTransaction
      try{tx=db.transaction('libraries',change?'readwrite':'readonly')}catch(error){db.close();reject(error);return}
      let result: RenderLibrary<T>; let failure: unknown
      tx.oncomplete=()=>{db.close();resolve(result)}
      tx.onabort=tx.onerror=()=>{db.close();reject(failure??tx.error??new Error('Render storage transaction failed.'))}
      const store=tx.objectStore('libraries');const get=store.get(key)
      get.onsuccess=()=>{
        try{
          const previous=parseRenderLibrary(get.result,parse)
          result=change?{version:1,revision:previous.revision+1,records:change(previous.records)}:previous
          if(change)store.put(serializeRenderLibrary(result,parse),key)
        }catch(error){failure=error;tx.abort()}
      }
    }
  })
}
