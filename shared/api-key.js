const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789'
const suffixLength = 48
const acceptanceLimit = 256 - (256 % alphabet.length)

export function generateApiKey() {
  let suffix = ''
  while (suffix.length < suffixLength) {
    const bytes = globalThis.crypto.getRandomValues(new Uint8Array(64))
    for (const byte of bytes) {
      if (byte >= acceptanceLimit) continue
      suffix += alphabet[byte % alphabet.length]
      if (suffix.length === suffixLength) break
    }
  }
  return 'sk-' + suffix
}
