/** Native share sheet when available (WhatsApp etc.), otherwise copy. */
export async function shareOrCopy(data: { title?: string; text?: string; url?: string }): Promise<'shared' | 'copied' | 'failed'> {
  if (navigator.share) {
    try {
      await navigator.share(data)
      return 'shared'
    } catch (e) {
      if ((e as Error).name === 'AbortError') return 'failed'
    }
  }
  return (await copyText([data.text, data.url].filter(Boolean).join('\n'))) ? 'copied' : 'failed'
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    return false
  }
}
