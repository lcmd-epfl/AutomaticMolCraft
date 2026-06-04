export class LRU<K, V> {
private map = new Map<K, V>()
constructor(private capacity = 50) {}
get(key: K): V | undefined {
const v = this.map.get(key)
if (v !== undefined) { this.map.delete(key); this.map.set(key, v) }
return v
}
set(key: K, val: V) {
if (this.map.has(key)) this.map.delete(key)
this.map.set(key, val)
if (this.map.size > this.capacity) {
const first = this.map.keys().next().value
this.map.delete(first)
}
}
}
