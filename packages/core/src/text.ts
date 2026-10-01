/**
 * Text that came from a person or a model, made safe to put in a message. Here, not in the types
 * package, so the dispatcher's own messages (a task's title in a notice) use the same rules.
 */

/**
 * A zero-width space: after an `@` it stops a ping and leaves the text readable. Built from its
 * code so the source stays ASCII (the formatter would turn a `\u` escape into the character).
 */
export const ZWSP = String.fromCharCode(0x200b)

/** Drops control characters other than newline and tab. */
function withoutControls(text: string): string {
  let out = ""
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0
    if ((code < 0x20 && ch !== "\n" && ch !== "\t") || code === 0x7f) continue
    out += ch
  }
  return out
}

/**
 * Makes text safe to put in a DM: no mention can ping (`@everyone`, `@here`, `<@id>`, `<@&id>`,
 * `<#id>`), no masked link can hide where it points, no control characters, one line per item
 * where the caller asks, and at most `max` characters.
 */
export function clean(text: string, max: number, oneLine = false): string {
  let out = withoutControls(text)
    // <@123>, <@!123>, <@&123>, <#123>, </cmd:123>: unwrap, so Discord renders plain text.
    .replace(/<(@[!&]?|#|\/)([^<>\s]{0,80})>/g, (_m, sigil: string, rest: string) => {
      return `${sigil === "/" ? "/" : sigil.replace(/[!&]/, "")}${ZWSP}${rest}`
    })
    // @everyone and @here: a zero-width space after the @ stops the ping.
    .replace(/@(everyone|here)/gi, `@${ZWSP}$1`)
    // [text](url): a masked link shows text and hides its target; break the pattern.
    .replace(/\]\(/g, "] (")
  if (oneLine) out = out.replace(/\s+/g, " ")
  out = out.trim()
  return out.length > max ? `${out.slice(0, max - 3).trimEnd()}...` : out
}
