import { RootedSolidFsSyncJournal as CanonicalRootedJournal, SqliteSolidFsSyncJournal as CanonicalSqliteJournal, type SolidFsSyncJournalOptions } from '@undefineds.co/xpod-afs/workcopy/SolidFsSyncJournal';
export * from '@undefineds.co/xpod-afs/workcopy/SolidFsSyncJournal';
/** Service DI adapter retaining the existing component IRI and constructor parameters. */
export class RootedSolidFsSyncJournal extends CanonicalRootedJournal {
  public constructor(rootFilePath: string, cwd = process.cwd()) { super(rootFilePath, cwd); }
}
/** Service DI adapter; all persistence behavior remains canonical in AFS. */
export class SqliteSolidFsSyncJournal extends CanonicalSqliteJournal {
  public constructor(options: SolidFsSyncJournalOptions) { super(options); }
}
