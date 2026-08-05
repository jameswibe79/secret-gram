interface PdfPreviewProps {
  url: string
  name: string
}

export function PdfPreview({ url, name }: PdfPreviewProps) {
  return (
    <iframe
      className="native-pdf-preview"
      src={url}
      title={`${name} browser PDF viewer`}
      referrerPolicy="no-referrer"
    />
  )
}
