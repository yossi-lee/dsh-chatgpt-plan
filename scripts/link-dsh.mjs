import { readdir, readFile, mkdir, symlink, lstat, unlink } from 'node:fs/promises'
import { resolve, join, dirname } from 'node:path'

const root = resolve(process.argv[2] ?? '../dsh')
const manifests = []
for (const entry of await readdir(join(root, 'vendor'), { withFileTypes: true })) {
  if (entry.isDirectory()) manifests.push(join(root, 'vendor', entry.name))
}
for (const group of await readdir(join(root, 'packages'), { withFileTypes: true })) {
  if (!group.isDirectory()) continue
  for (const entry of await readdir(join(root, 'packages', group.name), { withFileTypes: true })) {
    if (entry.isDirectory()) manifests.push(join(root, 'packages', group.name, entry.name))
  }
}
for (const path of manifests) {
  let name
  try { name = JSON.parse(await readFile(join(path, 'package.json'), 'utf8')).name }
  catch (error) { if (error.code === 'ENOENT') continue; throw error }
  const target = resolve('node_modules', name)
  await mkdir(dirname(target), { recursive: true })
  try {
    const existing = await lstat(target)
    if (!existing.isSymbolicLink()) continue
    await unlink(target)
  } catch (error) { if (error.code !== 'ENOENT') throw error }
  await symlink(path, target, 'dir')
}
console.log('Linked actual DSH packages from', root)
