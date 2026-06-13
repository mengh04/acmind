use sea_orm_migration::{prelude::*, schema::*};

use super::m20260101_000001_create_user::User;
use super::m20260101_000002_create_problem::Problem;

#[derive(DeriveMigrationName)]
pub struct Migration;

#[async_trait::async_trait]
impl MigrationTrait for Migration {
    async fn up(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .create_table(
                Table::create()
                    .table(Submission::Table)
                    .if_not_exists()
                    .col(pk_auto(Submission::Id).big_integer())
                    .col(big_integer(Submission::UserId))
                    .col(big_integer(Submission::ProblemId))
                    .col(string(Submission::Language))
                    .col(text(Submission::Code))
                    .col(string(Submission::Verdict))
                    .col(integer_null(Submission::RuntimeMs))
                    .col(integer_null(Submission::MemoryKb))
                    .col(text_null(Submission::Notes))
                    .col(
                        timestamp_with_time_zone(Submission::SubmittedAt)
                            .default(Expr::current_timestamp()),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_submission_user")
                            .from(Submission::Table, Submission::UserId)
                            .to(User::Table, User::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .foreign_key(
                        ForeignKey::create()
                            .name("fk_submission_problem")
                            .from(Submission::Table, Submission::ProblemId)
                            .to(Problem::Table, Problem::Id)
                            .on_delete(ForeignKeyAction::Cascade),
                    )
                    .to_owned(),
            )
            .await?;

        manager
            .create_index(
                Index::create()
                    .name("idx_submission_user_problem")
                    .table(Submission::Table)
                    .col(Submission::UserId)
                    .col(Submission::ProblemId)
                    .to_owned(),
            )
            .await
    }

    async fn down(&self, manager: &SchemaManager) -> Result<(), DbErr> {
        manager
            .drop_table(Table::drop().table(Submission::Table).to_owned())
            .await
    }
}

#[derive(DeriveIden)]
pub enum Submission {
    Table,
    Id,
    UserId,
    ProblemId,
    Language,
    Code,
    Verdict,
    RuntimeMs,
    MemoryKb,
    Notes,
    SubmittedAt,
    // Added by m20260612_120000_add_submission_run_id.
    ExternalRunId,
}
