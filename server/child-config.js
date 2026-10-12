// Edit CPA's block-style configuration without reserializing plugin settings,
// comments, or credentials. Resolve keys within their parent, never globally.
export function editChildConfig(source, { host, secret, port, replaceSecret = false, ensure = false, plugin }) {
  const newline = source.includes('\r\n') ? '\r\n' : '\n'
  const lines = source.split(/\r?\n/)
  const v8 = /^config-version:\s*["']?8["']?\s*(?:#.*)?$/m.test(source)
  const keyLine = line => /^( *)([\w-]+):(?:\s+(.*)|\s*)$/.exec(line)
  const meaningful = line => line.trim() && !line.trimStart().startsWith('#')

  function find(parent, key) {
    const matches = []
    for (let i = parent.start; i < parent.end; i++) {
      const match = keyLine(lines[i])
      if (match && match[1].length === parent.indent && match[2] === key) matches.push(i)
    }
    if (matches.length > 1) throw new Error(`duplicate CPA config key: ${key}; repair config.yaml before starting`)
    return matches[0] ?? -1
  }

  function block(keys) {
    let parent = { start: 0, end: lines.length, indent: 0 }
    for (const key of keys) {
      let index = find(parent, key)
      if (index < 0) {
        index = parent.end
        lines.splice(index, 0, `${' '.repeat(parent.indent)}${key}:`)
        parent.end++
      }
      const value = keyLine(lines[index])[3] || ''
      if (value.trim() && !value.trimStart().startsWith('#')) throw new Error(`CPA config ${key} must be a block mapping`)
      let end = index + 1
      while (end < parent.end) {
        if (meaningful(lines[end]) && (lines[end].match(/^ */)[0].length <= parent.indent)) break
        end++
      }
      const children = lines.slice(index + 1, end).filter(meaningful)
      const indent = children.length ? children[0].match(/^ */)[0].length : parent.indent + 2
      // Inconsistent sibling indentation was produced by older controllers.
      // Refuse to write an already damaged document rather than guessing.
      if (children.some(line => line.match(/^ */)[0].length < indent)) throw new Error(`inconsistent indentation in CPA config ${key}; repair config.yaml before starting`)
      parent = { start: index + 1, end, indent }
    }
    return parent
  }

  function set(keys, key, value, onlyEmpty = false) {
    const parent = block(keys)
    const index = find(parent, key)
    if (index >= 0) {
      const current = keyLine(lines[index])[3] || ''
      if (onlyEmpty && !/^(?:""|'')?\s*(?:#.*)?$/.test(current.trim())) return
      if (current.trim() === value) return
      lines[index] = `${' '.repeat(parent.indent)}${key}: ${value}`
    } else {
      lines.splice(parent.end, 0, `${' '.repeat(parent.indent)}${key}: ${value}`)
    }
  }

  const server = v8 ? ['server'] : []
  const management = [v8 ? 'management' : 'remote-management']
  if (ensure) {
    set(server, 'host', host)
    set(management, 'allow-remote', 'true')
    set(management, 'secret-key', JSON.stringify(secret), true)
    set(management, 'disable-control-panel', 'false')
    set(['plugins'], 'enabled', 'true')
  }
  if (port !== undefined) set(server, 'port', String(port))
  if (replaceSecret) set(management, 'secret-key', JSON.stringify(secret))
  if (plugin) {
    if (!/^[a-z][a-z0-9-]{0,99}$/.test(plugin.id)) throw new Error('invalid plugin id')
    set(['plugins'], 'enabled', 'true')
    set(['plugins', 'configs', plugin.id], 'enabled', 'true')
  }
  return lines.join(newline)
}
