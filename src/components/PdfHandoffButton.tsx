import { ExternalLink, LoaderCircle, ScanLine, ShieldAlert } from 'lucide-react'
import { useEffect, useRef, useState } from 'react'
import { toast } from 'sonner'

import { handoffPdfToHeron } from '../lib/pdf-handoff'
import { SecurityDialog } from './SecurityDialog'
import { Button } from './ui/button'

interface PdfHandoffButtonProps {
  data: Blob
  name: string
}

export function PdfHandoffButton({ data, name }: PdfHandoffButtonProps) {
  const abortRef = useRef<AbortController | null>(null)
  const [confirming, setConfirming] = useState(false)
  const [sending, setSending] = useState(false)

  useEffect(() => () => abortRef.current?.abort(), [])

  function confirmHandoff() {
    abortRef.current?.abort()
    const controller = new AbortController()
    abortRef.current = controller
    const operation = handoffPdfToHeron({ data, name, signal: controller.signal })
    setConfirming(false)
    setSending(true)
    void operation.then(() => {
      if (!controller.signal.aborted) toast.success('PDF sent to Heron Tools')
    }).catch((handoffError: unknown) => {
      if (controller.signal.aborted) return
      toast.error(
        handoffError instanceof Error
          ? handoffError.message
          : 'The decrypted PDF could not be sent to Heron Tools.',
      )
    }).finally(() => {
      if (!controller.signal.aborted) setSending(false)
      if (abortRef.current === controller) abortRef.current = null
    })
  }

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        type="button"
        disabled={sending}
        onClick={() => setConfirming(true)}
      >
        {sending ? <LoaderCircle className="spinning" /> : <ScanLine />}
        Adjust scan
      </Button>

      {confirming && (
        <SecurityDialog title="Adjust scanned PDF in Heron Tools" onClose={() => setConfirming(false)}>
          <div className="pdf-handoff-warning">
            <ShieldAlert aria-hidden="true" />
            <div>
              <strong>This sends decrypted content to another website.</strong>
              <p>
                SecretGram will transfer the PDF bytes and filename directly to the tab at
                {' '}<code>heron.tools</code>. SecretGram servers do not receive the plaintext,
                but code served by Heron Tools can read it.
              </p>
              <p>Continue only if you trust Heron Tools with this document.</p>
            </div>
          </div>
          <div className="pdf-handoff-actions">
            <Button type="button" variant="outline" onClick={() => setConfirming(false)}>Cancel</Button>
            <Button type="button" onClick={confirmHandoff}>
              <ExternalLink />
              Send to Heron Tools
            </Button>
          </div>
        </SecurityDialog>
      )}
    </>
  )
}
