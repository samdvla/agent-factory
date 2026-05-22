use serde::Serialize;
use serde_json::Value;
use sqlx::SqlitePool;

#[derive(Debug, Clone, Serialize, sqlx::FromRow)]
pub struct Job {
    pub id: i64,
    pub project_id: i64,
    pub agent_role: String,
    pub payload_json: String,
    pub status: String,
    pub attempts: i64,
}

pub async fn enqueue(
    pool: &SqlitePool,
    project_id: i64,
    agent_role: &str,
    payload: Value,
) -> anyhow::Result<i64> {
    let payload_str = payload.to_string();
    let id: i64 = sqlx::query_scalar(
        "INSERT INTO jobs (project_id, agent_role, payload_json) VALUES (?, ?, ?) RETURNING id"
    )
    .bind(project_id)
    .bind(agent_role)
    .bind(payload_str)
    .fetch_one(pool)
    .await?;
    Ok(id)
}

pub async fn claim(pool: &SqlitePool, agent_role: &str) -> anyhow::Result<Option<Job>> {
    let mut tx = pool.begin().await?;
    let row: Option<Job> = sqlx::query_as(
        r#"SELECT id, project_id, agent_role, payload_json, status, attempts
           FROM jobs
           WHERE agent_role = ? AND status = 'queued'
           ORDER BY scheduled_at ASC
           LIMIT 1"#
    )
    .bind(agent_role)
    .fetch_optional(&mut *tx)
    .await?;

    if let Some(mut job) = row {
        sqlx::query(
            "UPDATE jobs SET status = 'running', started_at = datetime('now'), attempts = attempts + 1 WHERE id = ? AND status = 'queued'"
        )
        .bind(job.id)
        .execute(&mut *tx)
        .await?;
        tx.commit().await?;
        job.status = "running".into();
        job.attempts += 1;
        Ok(Some(job))
    } else {
        tx.rollback().await?;
        Ok(None)
    }
}

/// Operator skip: cancel a job that hasn't started yet. Only `queued`
/// jobs can be skipped — a `running` job is mid-flight in a worker and
/// cancelling it cleanly would require killing the worker process, so we
/// refuse and let it finish. Returns true if a row was actually
/// cancelled, false if the job wasn't found or was no longer queued
/// (e.g. it got claimed between the UI render and the click).
pub async fn skip(pool: &SqlitePool, job_id: i64) -> anyhow::Result<bool> {
    let res = sqlx::query(
        "UPDATE jobs SET status = 'cancelled', finished_at = datetime('now'), \
         error = 'skipped by operator' WHERE id = ? AND status = 'queued'"
    )
    .bind(job_id)
    .execute(pool)
    .await?;
    Ok(res.rows_affected() > 0)
}

pub async fn complete(pool: &SqlitePool, job_id: i64, result: Value) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE jobs SET status = 'done', finished_at = datetime('now'), result_json = ? WHERE id = ?"
    )
    .bind(result.to_string())
    .bind(job_id)
    .execute(pool)
    .await?;
    Ok(())
}

pub async fn fail(pool: &SqlitePool, job_id: i64, error: &str) -> anyhow::Result<()> {
    sqlx::query(
        "UPDATE jobs SET status = 'errored', finished_at = datetime('now'), error = ? WHERE id = ?"
    )
    .bind(error)
    .bind(job_id)
    .execute(pool)
    .await?;
    Ok(())
}
