import type { Message } from "discord.js"

const buildUserMentionIndex = (message: Message) => {
  const byAlias = new Map<string, Set<string>>()
  const addAlias = (alias: string, id: string) => {
    const normalized = alias.trim().toLowerCase()
    if (!normalized) return
    const existing = byAlias.get(normalized) ?? new Set<string>()
    existing.add(id)
    byAlias.set(normalized, existing)
  }

  addAlias(message.author.username, message.author.id)
  if (message.author.globalName) addAlias(message.author.globalName, message.author.id)
  if (message.member?.displayName) addAlias(message.member.displayName, message.author.id)

  if (message.guild) {
    for (const member of message.guild.members.cache.values()) {
      addAlias(member.user.username, member.user.id)
      if (member.user.globalName) addAlias(member.user.globalName, member.user.id)
      if (member.displayName) addAlias(member.displayName, member.user.id)
    }
  }

  return byAlias
}

const buildRoleMentionIndex = (message: Message) => {
  const byAlias = new Map<string, Set<string>>()
  if (!message.guild) {
    return byAlias
  }

  for (const role of message.guild.roles.cache.values()) {
    const normalized = role.name.trim().toLowerCase()
    if (!normalized) {
      continue
    }
    const existing = byAlias.get(normalized) ?? new Set<string>()
    existing.add(role.id)
    byAlias.set(normalized, existing)
  }
  return byAlias
}

const resolveSingle = (ids: Set<string> | undefined) => {
  if (!ids || ids.size !== 1) {
    return null
  }
  return [...ids][0] ?? null
}

export const normalizeOutgoingMentions = (message: Message, text: string) => {
  const userByAlias = buildUserMentionIndex(message)
  const roleByAlias = buildRoleMentionIndex(message)

  const candidateRegex = /(^|[\s([{"'])@([A-Za-z0-9_.-]+)/g
  return text.replace(candidateRegex, (match, prefix: string, rawAlias: string) => {
    const alias = rawAlias.toLowerCase()
    if (alias === "everyone" || alias === "here") {
      return match
    }

    const userId = resolveSingle(userByAlias.get(alias))
    if (userId) {
      return `${prefix}<@${userId}>`
    }

    const roleId = resolveSingle(roleByAlias.get(alias))
    if (roleId) {
      return `${prefix}<@&${roleId}>`
    }

    return match
  })
}
