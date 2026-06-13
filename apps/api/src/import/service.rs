use crate::{error::AppResult, import::model::*, state::AppState, tag::repo as tag_repo};
use chrono::{DateTime, Utc};
use sea_orm::{ConnectionTrait, DatabaseConnection, DbBackend, Statement};

pub struct ImportService<'a> {
    pub state: &'a AppState,
}

impl<'a> ImportService<'a> {
    pub fn new(state: &'a AppState) -> Self {
        Self { state }
    }

    /// Import a problem and all its submissions in one request.
    pub async fn import_problem_full(
        &self,
        user_id: i64,
        req: &ImportProblemFullReq,
    ) -> AppResult<ImportProblemFullResp> {
        let db = &self.state.db;
        let source = format!("VJudge:{}", req.oj);

        // Find or create problem
        let (problem_id, is_new) = find_or_create_problem(
            db,
            user_id,
            &source,
            &req.source_problem_id,
            &req.title,
            req.url.as_deref(),
            req.statement.as_deref(),
        )
        .await?;

        // Link tags
        if is_new {
            if let Some(tag_names) = &req.tags {
                for name in tag_names {
                    let tag = tag_repo::insert(db, user_id, name).await?;
                    link_problem_tag(db, problem_id, tag.id).await?;
                }
            }
        }

        // Import submissions
        let mut imported = 0;
        let mut skipped = 0;
        let mut errors = Vec::new();

        for sub in &req.submissions {
            let verdict = map_verdict(&sub.status);
            let code = sub.code.as_deref().unwrap_or("");
            let runtime_ms = sub.runtime.as_deref().and_then(parse_runtime_ms);
            let memory_kb = sub.memory.as_deref().and_then(parse_memory_kb);
            let run_id = sub.run_id.as_deref().filter(|s| !s.is_empty());
            let submitted_at = sub
                .submit_time
                .as_deref()
                .and_then(parse_submit_time)
                .unwrap_or_else(Utc::now);

            // Dedup. Prefer the external run id (globally stable, so re-imports are
            // idempotent regardless of timing). Fall back to code+verdict only when
            // no run id is available (e.g. manual submissions).
            let dup = match run_id {
                Some(rid) => is_duplicate_by_run_id(db, user_id, rid).await,
                None => is_duplicate_by_code(db, user_id, problem_id, &verdict, code).await,
            };
            match dup {
                Ok(true) => {
                    skipped += 1;
                    continue;
                }
                Ok(false) => {}
                Err(e) => {
                    errors.push(format!("dedup check: {e}"));
                    continue;
                }
            }

            match insert_submission(
                db,
                user_id,
                problem_id,
                &sub.language,
                code,
                &verdict,
                runtime_ms,
                memory_kb,
                run_id,
                submitted_at,
            )
            .await
            {
                Ok(_) => imported += 1,
                Err(e) => errors.push(format!("{}: {}", sub.prob_num, e)),
            }
        }

        Ok(ImportProblemFullResp {
            problem_id,
            submissions_imported: imported,
            submissions_skipped: skipped,
            errors,
        })
    }
}

// ---- DB helpers ----

async fn find_or_create_problem(
    db: &DatabaseConnection,
    user_id: i64,
    source: &str,
    external_id: &str,
    title: &str,
    url: Option<&str>,
    statement: Option<&str>,
) -> AppResult<(i64, bool)> {
    if let Some(id) = find_problem_by_external(db, user_id, source, external_id).await? {
        return Ok((id, false));
    }
    let id = insert_problem(db, user_id, source, external_id, title, url, statement).await?;
    Ok((id, true))
}

async fn find_problem_by_external(
    db: &DatabaseConnection,
    user_id: i64,
    source: &str,
    external_id: &str,
) -> AppResult<Option<i64>> {
    let stmt = Statement::from_string(
        DbBackend::Postgres,
        format!(
            "SELECT id FROM problem WHERE user_id = {} AND source = '{}' AND external_id = '{}'",
            user_id,
            source.replace('\'', "''"),
            external_id.replace('\'', "''"),
        ),
    );
    Ok(db
        .query_one(stmt)
        .await?
        .and_then(|r| r.try_get_by::<i64, _>("id").ok()))
}

async fn insert_problem(
    db: &DatabaseConnection,
    user_id: i64,
    source: &str,
    external_id: &str,
    title: &str,
    url: Option<&str>,
    statement: Option<&str>,
) -> AppResult<i64> {
    let now = Utc::now();
    let stmt = Statement::from_string(
        DbBackend::Postgres,
        format!(
            r#"INSERT INTO problem (user_id, source, external_id, title, url, statement, created_at, updated_at)
               VALUES ({}, '{}', '{}', '{}', {}, {}, '{}', '{}')
               RETURNING id"#,
            user_id,
            source.replace('\'', "''"),
            external_id.replace('\'', "''"),
            title.replace('\'', "''"),
            opt_str(url),
            opt_str(statement),
            now.to_rfc3339(),
            now.to_rfc3339(),
        ),
    );
    let row = db
        .query_one(stmt)
        .await?
        .ok_or_else(|| crate::error::AppError::Internal("problem insert returned no row".into()))?;
    row.try_get_by::<i64, _>("id")
        .map_err(|e| crate::error::AppError::Internal(format!("problem id parse: {e}")))
}

async fn link_problem_tag(db: &DatabaseConnection, problem_id: i64, tag_id: i64) -> AppResult<()> {
    let stmt = Statement::from_string(
        DbBackend::Postgres,
        format!(
            "INSERT INTO problem_tag (problem_id, tag_id) VALUES ({}, {}) ON CONFLICT DO NOTHING",
            problem_id, tag_id,
        ),
    );
    db.execute(stmt).await?;
    Ok(())
}

#[allow(clippy::too_many_arguments)]
async fn insert_submission(
    db: &DatabaseConnection,
    user_id: i64,
    problem_id: i64,
    language: &str,
    code: &str,
    verdict: &str,
    runtime_ms: Option<i32>,
    memory_kb: Option<i32>,
    external_run_id: Option<&str>,
    submitted_at: DateTime<Utc>,
) -> AppResult<i64> {
    let stmt = Statement::from_string(
        DbBackend::Postgres,
        format!(
            r#"INSERT INTO submission (user_id, problem_id, language, code, verdict, runtime_ms, memory_kb, external_run_id, submitted_at)
               VALUES ({}, {}, '{}', '{}', '{}', {}, {}, {}, '{}')
               RETURNING id"#,
            user_id,
            problem_id,
            language.replace('\'', "''"),
            code.replace('\'', "''"),
            verdict.replace('\'', "''"),
            opt_i32(runtime_ms),
            opt_i32(memory_kb),
            opt_str(external_run_id),
            submitted_at.to_rfc3339(),
        ),
    );
    let row = db.query_one(stmt).await?.ok_or_else(|| {
        crate::error::AppError::Internal("submission insert returned no row".into())
    })?;
    row.try_get_by::<i64, _>("id")
        .map_err(|e| crate::error::AppError::Internal(format!("submission id parse: {e}")))
}

async fn is_duplicate_by_run_id(
    db: &DatabaseConnection,
    user_id: i64,
    run_id: &str,
) -> AppResult<bool> {
    let stmt = Statement::from_string(
        DbBackend::Postgres,
        format!(
            "SELECT 1 AS x FROM submission \
             WHERE user_id = {} AND external_run_id = '{}' \
             LIMIT 1",
            user_id,
            run_id.replace('\'', "''"),
        ),
    );
    Ok(db.query_one(stmt).await?.is_some())
}

async fn is_duplicate_by_code(
    db: &DatabaseConnection,
    user_id: i64,
    problem_id: i64,
    verdict: &str,
    code: &str,
) -> AppResult<bool> {
    // No run id to key on. An empty body carries no signal, so never dedup it —
    // let it through rather than collapsing distinct attempts.
    if code.is_empty() {
        return Ok(false);
    }
    let code_hash = format!("{:x}", md5::compute(code));
    let stmt = Statement::from_string(
        DbBackend::Postgres,
        format!(
            "SELECT 1 AS x FROM submission \
             WHERE user_id = {} AND problem_id = {} AND verdict = '{}' \
             AND md5(code) = '{}' \
             LIMIT 1",
            user_id,
            problem_id,
            verdict.replace('\'', "''"),
            code_hash,
        ),
    );
    Ok(db.query_one(stmt).await?.is_some())
}

// ---- Parsing helpers ----

fn map_verdict(vjudge_status: &str) -> String {
    let s = vjudge_status.to_uppercase();
    if s.contains("ACCEPTED") || s == "AC" {
        "AC".to_string()
    } else if s.contains("WRONG") || s == "WA" {
        "WA".to_string()
    } else if s.contains("TIME LIMIT") || s == "TLE" {
        "TLE".to_string()
    } else if s.contains("MEMORY LIMIT") || s == "MLE" {
        "MLE".to_string()
    } else if s.contains("RUNTIME") || s == "RE" {
        "RE".to_string()
    } else if s.contains("COMPILATION") || s.contains("COMPILE") || s == "CE" {
        "CE".to_string()
    } else {
        "PENDING".to_string()
    }
}

/// VJudge reports submission time as epoch milliseconds.
fn parse_submit_time(s: &str) -> Option<DateTime<Utc>> {
    let ms: i64 = s.trim().parse().ok()?;
    DateTime::from_timestamp_millis(ms)
}

fn parse_runtime_ms(s: &str) -> Option<i32> {
    s.chars()
        .filter(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse::<i32>()
        .ok()
}

fn parse_memory_kb(s: &str) -> Option<i32> {
    s.chars()
        .filter(|c| c.is_ascii_digit())
        .collect::<String>()
        .parse::<i32>()
        .ok()
}

fn opt_str(s: Option<&str>) -> String {
    match s {
        Some(v) => format!("'{}'", v.replace('\'', "''")),
        None => "NULL".to_string(),
    }
}

fn opt_i32(v: Option<i32>) -> String {
    match v {
        Some(n) => n.to_string(),
        None => "NULL".to_string(),
    }
}
