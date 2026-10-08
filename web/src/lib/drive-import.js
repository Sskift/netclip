export function selectedFiles(files) {
  return [...files].map((file) => ({ file, path: file.webkitRelativePath || file.name }))
}

// Capture entries before the drop event ends; its DataTransfer is then protected.
export function droppedFiles(transfer) {
  const entries = [...transfer.items].filter((item) => item.kind === 'file').map((item) => item.webkitGetAsEntry?.())
  const fallback = selectedFiles(transfer.files)
  if (!entries.length || entries.some((entry) => !entry)) return Promise.resolve({ files: fallback, directories: [] })
  const files = [], directories = []
  async function walk(entry, parent = '') {
    const path = parent + entry.name
    if (entry.isFile) {
      const file = await new Promise((resolve, reject) => entry.file(resolve, reject))
      files.push({ file, path })
    } else if (entry.isDirectory) {
      directories.push(path)
      const reader = entry.createReader()
      // Chromium returns at most 100 entries per call. Continue until exhausted.
      for (;;) {
        const children = await new Promise((resolve, reject) => reader.readEntries(resolve, reject))
        if (!children.length) break
        for (const child of children) await walk(child, `${path}/`)
      }
    }
  }
  return Promise.all(entries.map((entry) => walk(entry))).then(() => ({ files, directories }))
}

export function folderResolver(destination, createFolder) {
  const folders = new Map([['', Promise.resolve(destination)]])
  function ensure(path) {
    if (!folders.has(path)) {
      const slash = path.lastIndexOf('/')
      const parent = slash === -1 ? '' : path.slice(0, slash), name = path.slice(slash + 1)
      folders.set(path, ensure(parent).then((parentId) => createFolder(name, parentId)).then((entry) => entry.id))
    }
    return folders.get(path)
  }
  return ensure
}
