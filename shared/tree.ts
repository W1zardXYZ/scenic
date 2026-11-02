// A project's `pack` is its path through nested projects, like a folder path.

export const SEPARATOR = '/'

export const cleanName = (name: string) => name.trim().replaceAll(SEPARATOR, '-')
export const joinPath = (parent: string, child: string) => (parent && child ? `${parent}${SEPARATOR}${child}` : parent || child)
export const parentPath = (path: string) => path.slice(0, Math.max(0, path.lastIndexOf(SEPARATOR)))
export const leafName = (path: string) => path.slice(path.lastIndexOf(SEPARATOR) + 1)
export const isWithin = (path: string, root: string) => !root || path === root || path.startsWith(root + SEPARATOR)

/** `path` as it reads after the folder at `from` moves to `to`. */
export function rebasePath(path: string, from: string, to: string): string {
  return joinPath(to, path.slice(from.length).replace(/^\//, ''))
}
