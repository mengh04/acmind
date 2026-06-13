pub use sea_orm_migration::prelude::*;

mod m20260101_000001_create_user;
mod m20260101_000002_create_problem;
mod m20260101_000003_create_submission;
mod m20260101_000004_create_knowledge;
mod m20260101_000005_create_tag;
mod m20260101_000006_create_join_tables;
mod m20260608_142216_create_ai_analysis;
mod m20260609_090000_create_task;
mod m20260610_090000_create_template;
mod m20260610_100000_add_template_summary;
mod m20260612_120000_add_submission_run_id;

pub struct Migrator;

#[async_trait::async_trait]
impl MigratorTrait for Migrator {
    fn migrations() -> Vec<Box<dyn MigrationTrait>> {
        vec![
            Box::new(m20260101_000001_create_user::Migration),
            Box::new(m20260101_000002_create_problem::Migration),
            Box::new(m20260101_000003_create_submission::Migration),
            Box::new(m20260101_000004_create_knowledge::Migration),
            Box::new(m20260101_000005_create_tag::Migration),
            Box::new(m20260101_000006_create_join_tables::Migration),
            Box::new(m20260608_142216_create_ai_analysis::Migration),
            Box::new(m20260609_090000_create_task::Migration),
            Box::new(m20260610_090000_create_template::Migration),
            Box::new(m20260610_100000_add_template_summary::Migration),
            Box::new(m20260612_120000_add_submission_run_id::Migration),
        ]
    }
}
