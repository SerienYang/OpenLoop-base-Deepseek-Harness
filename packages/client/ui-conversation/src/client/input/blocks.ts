/**
 * Composer blocks: the one way another plugin stops a session's input.
 *
 * The composer cannot read the plugins that would know — the dependency runs
 * ui-model-selection → ui-conversation, never back — so a blocker pushes here and the
 * bar reads its own session's store. A block carries the localized reason it
 * exists, because the plugin that raised it owns that copy; the composer only
 * knows how to render an inert textarea with a placeholder, exactly as it
 * already does for a session with no workspace.
 *
 * This is an affordance, not enforcement: the Host refuses a prompt it cannot
 * route regardless of what any client disables.
 */

import { createSnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'
import type { SessionId, SnapshotStore } from '@deepseek-ai/dsh-client-runtime/client'

/** Why one session's composer is inert. */
export interface ComposerBlock {
  /**
   * Localized placeholder replacing the composer's own, owned by the plugin
   * that raised the block.
   */
  readonly reason: string
}

/** The registry face other plugins reach through `ctx.conversation.blocks`. */
export interface ComposerBlocks {
  /**
   * Raise or clear this session's block. Idempotent: setting a block equal to
   * the current one, or clearing an absent one, notifies nobody.
   * @param sessionId - the session whose composer is affected.
   * @param block - the block to raise, or undefined to clear it.
   */
  set(sessionId: SessionId, block: ComposerBlock | undefined): void
  /**
   * Raise or clear only one source's block. Other sources remain registered,
   * so releasing one condition cannot accidentally unlock another.
   * @param sessionId - the session whose composer is affected.
   * @param owner - stable source key owned by the calling plugin.
   * @param block - this owner's block, or undefined to clear only this owner.
   */
  setOwned(sessionId: SessionId, owner: string, block: ComposerBlock | undefined): void
  /**
   * The store the composer subscribes to for one session. Created on first
   * read from either side, so a blocker may raise a block before the session's
   * composer mounts and the composer still sees it.
   * @param sessionId - the session to observe.
   * @returns that session's block store (undefined value = not blocked).
   */
  storeFor(sessionId: SessionId): SnapshotStore<ComposerBlock | undefined>
  /**
   * Drop one session's store. The session scope's disposer calls this; a
   * blocker never needs to.
   * @param sessionId - the session being torn down.
   */
  forget(sessionId: SessionId): void
}

/** The per-session composer-block registry (one instance per plugin fiber). */
export class ComposerBlockRegistry implements ComposerBlocks {
  private static readonly LEGACY_OWNER = 'ui-conversation:legacy'
  private readonly stores = new Map<SessionId, SnapshotStore<ComposerBlock | undefined>>()
  private readonly owned = new Map<SessionId, Map<string, ComposerBlock>>()

  /** @inheritdoc */
  set(sessionId: SessionId, block: ComposerBlock | undefined): void {
    this.setOwned(sessionId, ComposerBlockRegistry.LEGACY_OWNER, block)
  }

  /** @inheritdoc */
  setOwned(sessionId: SessionId, owner: string, block: ComposerBlock | undefined): void {
    const store = this.storeFor(sessionId)
    let entries = this.owned.get(sessionId)
    if (entries === undefined) {
      entries = new Map()
      this.owned.set(sessionId, entries)
    }
    const current = store.getSnapshot()
    if (block === undefined) entries.delete(owner)
    else entries.set(owner, block)
    if (entries.size === 0) this.owned.delete(sessionId)
    const next = entries.get(ComposerBlockRegistry.LEGACY_OWNER)
      ?? entries.values().next().value
    if (current?.reason === next?.reason) return
    store.set(next)
  }

  /** @inheritdoc */
  storeFor(sessionId: SessionId): SnapshotStore<ComposerBlock | undefined> {
    const existing = this.stores.get(sessionId)
    if (existing !== undefined) return existing
    const created = createSnapshotStore<ComposerBlock | undefined>(undefined)
    this.stores.set(sessionId, created)
    return created
  }

  /** @inheritdoc */
  forget(sessionId: SessionId): void {
    this.owned.delete(sessionId)
    this.stores.delete(sessionId)
  }
}
