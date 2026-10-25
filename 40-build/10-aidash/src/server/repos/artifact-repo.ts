import type { Artifact } from '../../shared/types.js';
import type { Db } from '../db/connection.js';

/* ------------------------------------------------------------------ *
 * artifact
 * ------------------------------------------------------------------ */

export class ArtifactRepo {
  constructor(private readonly db: Db) {}

  insert(artifact: Artifact): Artifact {
    this.db
      .prepare(
        `INSERT INTO artifact(id, card_id, kind, url, summary, size_bytes, created_at)
         VALUES (?,?,?,?,?,?,?)`,
      )
      .run(
        artifact.id,
        artifact.card_id,
        artifact.kind,
        artifact.url,
        artifact.summary,
        artifact.size_bytes,
        artifact.created_at,
      );
    return artifact;
  }

  listByCard(cardId: string): Artifact[] {
    return this.db
      .prepare('SELECT * FROM artifact WHERE card_id = ? ORDER BY created_at DESC')
      .all(cardId) as Artifact[];
  }

  get(id: string): Artifact | undefined {
    return this.db.prepare('SELECT * FROM artifact WHERE id = ?').get(id) as
      | Artifact
      | undefined;
  }
}
