use sea_orm_migration::prelude::*;

use super::m20260101_000003_create_submission::Submission;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        // External run id (e.g. VJudge runId). Nullable: manual submissions and
        // submissions whose source fetch failed keep it NULL.
        manager
            .alter_table(
                Table::alter()
                    .table(Submission::Table)
                    .add_column(ColumnDef::new(Submission::ExternalRunId).text().null())
                    .to_owned(),
            )
            .await?;

        // Partial unique index: one row per (user, run id), but allow many NULLs
        // (manual entries / failed source fetches do not collide).
        manager
            .get_connection()
            .execute_unprepared(
                "CREATE UNIQUE INDEX IF NOT EXISTS idx_submission_user_run_id \
                 ON submission (user_id, external_run_id) \
                 WHERE external_run_id IS NOT NULL",
            )
            .await?;

        Ok(())
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .get_connection()
            .execute_unprepared("DROP INDEX IF EXISTS idx_submission_user_run_id")
            .await?;

        manager
            .alter_table(
                Table::alter()
                    .table(Submission::Table)
                    .drop_column(Submission::ExternalRunId)
                    .to_owned(),
            )
            .await
    }
}
