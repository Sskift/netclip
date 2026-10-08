import { formatBytes } from '../lib/time.js'

export default function ImageUpload({ image }) {
  if (!image) return null
  return (
    <div className="nc-image-upload" role="status">
      {image.url && <img src={image.url} alt="" decoding="async" />}
      <div>
        <strong>{image.file.name || 'Image'}</strong>
        <span>Uploading… · {formatBytes(image.file.size)}</span>
      </div>
      <span className="nc-spinner" aria-hidden="true" />
    </div>
  )
}
