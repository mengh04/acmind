use acmind_api::{ai::provider::NoopLlmProvider, auth::jwt, state::AppState};
use acmind_migration::MigratorTrait;
use sea_orm::Database;
use std::sync::Arc;
use tokio::sync::OnceCell;

// Only a "migrations done" marker — never store a pool here. A sqlx pool is
// bound to the tokio runtime that created it, and #[tokio::test] gives each
// test its own runtime; a shared pool hangs (30s acquire timeout) once its
// origin runtime is torn down.
static MIGRATED: OnceCell<()> = OnceCell::const_new();

async fn connect() -> sea_orm::DatabaseConnection {
    let db_url = std::env::var("TEST_DATABASE_URL")
        .expect("TEST_DATABASE_URL must be set for integration tests");
    Database::connect(&db_url)
        .await
        .expect("failed to connect to test database")
}

pub async fn test_state() -> AppState {
    // Run migrations exactly once, on a throwaway connection that is dropped
    // immediately so no pool outlives the runtime that created it.
    MIGRATED
        .get_or_init(|| async {
            let db = connect().await;
            acmind_migration::Migrator::up(&db, None)
                .await
                .expect("failed to run migrations");
        })
        .await;

    // Each test gets its own pool, created in its own runtime.
    AppState {
        db: connect().await,
        jwt_secret: Arc::new("test-secret-for-integration".into()),
        jwt_expires_in: 3600,
        allow_register: true,
        rate_limit_per_second: 100,
        rate_limit_burst: 200,
        llm: Arc::new(NoopLlmProvider),
    }
}

pub fn test_router(state: AppState) -> axum::Router {
    let auth_layer = axum::middleware::from_fn_with_state(
        state.clone(),
        acmind_api::auth::middleware::require_auth,
    );

    let api = axum::Router::new()
        .merge(acmind_api::auth::route::public_router())
        .merge(acmind_api::auth::route::protected_router().route_layer(auth_layer.clone()))
        .merge(acmind_api::problem::route::protected_router().route_layer(auth_layer.clone()))
        .merge(acmind_api::submission::route::protected_router().route_layer(auth_layer.clone()))
        .merge(acmind_api::knowledge::route::protected_router().route_layer(auth_layer.clone()))
        .merge(acmind_api::tag::route::protected_router().route_layer(auth_layer.clone()))
        .merge(acmind_api::analysis::route::protected_router().route_layer(auth_layer.clone()))
        .merge(acmind_api::import::route::protected_router().route_layer(auth_layer.clone()))
        .merge(acmind_api::ai::route::protected_router().route_layer(auth_layer.clone()))
        .merge(acmind_api::task::route::protected_router().route_layer(auth_layer.clone()))
        .merge(acmind_api::template::route::protected_router().route_layer(auth_layer));

    axum::Router::new()
        .merge(acmind_api::health::router())
        .nest("/api/v1", api)
        .with_state(state)
}

/// Issue a valid JWT token for the given user.
pub fn auth_token(secret: &str, user_id: i64, username: &str) -> String {
    jwt::issue(secret, user_id, username, 3600).expect("failed to issue test token")
}

/// Check if TEST_DATABASE_URL is set. If not, return false.
pub fn has_test_db() -> bool {
    std::env::var("TEST_DATABASE_URL").is_ok()
}
