export function downloadTextFile(name: string, text: string) {
const blob = new Blob([text], { type: 'text/plain' })
const url = URL.createObjectURL(blob)
const a = document.createElement('a')
a.href = url; a.download = name; a.click(); URL.revokeObjectURL(url)
}
