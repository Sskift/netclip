export default function PageHeading({ eyebrow, title, description }) {
  return <div className="nw-page-heading">
    <div className="nw-eyebrow">{eyebrow}</div>
    <h1>{title}</h1>
    <p>{description}</p>
  </div>
}
