--
-- PostgreSQL database cluster dump
--

\restrict EyVnlQwNoq3dyPxT5qcXGnIlh5i5ai8L15mYRib2TdhMWre3sFeeqVHDpsNRgb9

SET default_transaction_read_only = off;

SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;

--
-- Roles
--

CREATE ROLE squads;
ALTER ROLE squads WITH SUPERUSER INHERIT CREATEROLE CREATEDB LOGIN REPLICATION BYPASSRLS PASSWORD 'SCRAM-SHA-256$4096:CpWScgLsblpzMONnn5D3Og==$pStj2c6iSNqg55/iXHux2TLmYJcqLoZAI3F1UbNUENE=:TaCVrLL336nDJq6/Uft0A4CIFP68EWOXC45QRdi1sWM=';

--
-- User Configurations
--








\unrestrict EyVnlQwNoq3dyPxT5qcXGnIlh5i5ai8L15mYRib2TdhMWre3sFeeqVHDpsNRgb9

--
-- Databases
--

--
-- Database "template1" dump
--

\connect template1

--
-- PostgreSQL database dump
--

\restrict Jnmb6HcbUsc46SbRpR6RsypLP7tEvPqGTxsHI8bvwphurg2yrri59yN2G3Ee1zW

-- Dumped from database version 16.11
-- Dumped by pg_dump version 16.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- PostgreSQL database dump complete
--

\unrestrict Jnmb6HcbUsc46SbRpR6RsypLP7tEvPqGTxsHI8bvwphurg2yrri59yN2G3Ee1zW

--
-- Database "langfuse" dump
--

--
-- PostgreSQL database dump
--

\restrict dbqJrS9dCgqQa9recDJhrdJA0aTPFZxvWVxcf4zHj6cabOTqrzVLK8LEOEvS7m9

-- Dumped from database version 16.11
-- Dumped by pg_dump version 16.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: langfuse; Type: DATABASE; Schema: -; Owner: squads
--

CREATE DATABASE langfuse WITH TEMPLATE = template0 ENCODING = 'UTF8' LOCALE_PROVIDER = libc LOCALE = 'en_US.utf8';


ALTER DATABASE langfuse OWNER TO squads;

\unrestrict dbqJrS9dCgqQa9recDJhrdJA0aTPFZxvWVxcf4zHj6cabOTqrzVLK8LEOEvS7m9
\connect langfuse
\restrict dbqJrS9dCgqQa9recDJhrdJA0aTPFZxvWVxcf4zHj6cabOTqrzVLK8LEOEvS7m9

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: AnnotationQueueObjectType; Type: TYPE; Schema: public; Owner: squads
--

CREATE TYPE public."AnnotationQueueObjectType" AS ENUM (
    'TRACE',
    'OBSERVATION'
);


ALTER TYPE public."AnnotationQueueObjectType" OWNER TO squads;

--
-- Name: AnnotationQueueStatus; Type: TYPE; Schema: public; Owner: squads
--

CREATE TYPE public."AnnotationQueueStatus" AS ENUM (
    'PENDING',
    'COMPLETED'
);


ALTER TYPE public."AnnotationQueueStatus" OWNER TO squads;

--
-- Name: CommentObjectType; Type: TYPE; Schema: public; Owner: squads
--

CREATE TYPE public."CommentObjectType" AS ENUM (
    'TRACE',
    'OBSERVATION',
    'SESSION',
    'PROMPT'
);


ALTER TYPE public."CommentObjectType" OWNER TO squads;

--
-- Name: DatasetStatus; Type: TYPE; Schema: public; Owner: squads
--

CREATE TYPE public."DatasetStatus" AS ENUM (
    'ACTIVE',
    'ARCHIVED'
);


ALTER TYPE public."DatasetStatus" OWNER TO squads;

--
-- Name: JobConfigState; Type: TYPE; Schema: public; Owner: squads
--

CREATE TYPE public."JobConfigState" AS ENUM (
    'ACTIVE',
    'INACTIVE'
);


ALTER TYPE public."JobConfigState" OWNER TO squads;

--
-- Name: JobExecutionStatus; Type: TYPE; Schema: public; Owner: squads
--

CREATE TYPE public."JobExecutionStatus" AS ENUM (
    'COMPLETED',
    'ERROR',
    'PENDING',
    'CANCELLED'
);


ALTER TYPE public."JobExecutionStatus" OWNER TO squads;

--
-- Name: JobType; Type: TYPE; Schema: public; Owner: squads
--

CREATE TYPE public."JobType" AS ENUM (
    'EVAL'
);


ALTER TYPE public."JobType" OWNER TO squads;

--
-- Name: ObservationLevel; Type: TYPE; Schema: public; Owner: squads
--

CREATE TYPE public."ObservationLevel" AS ENUM (
    'DEBUG',
    'DEFAULT',
    'WARNING',
    'ERROR'
);


ALTER TYPE public."ObservationLevel" OWNER TO squads;

--
-- Name: ObservationType; Type: TYPE; Schema: public; Owner: squads
--

CREATE TYPE public."ObservationType" AS ENUM (
    'SPAN',
    'EVENT',
    'GENERATION'
);


ALTER TYPE public."ObservationType" OWNER TO squads;

--
-- Name: Role; Type: TYPE; Schema: public; Owner: squads
--

CREATE TYPE public."Role" AS ENUM (
    'OWNER',
    'ADMIN',
    'MEMBER',
    'VIEWER',
    'NONE'
);


ALTER TYPE public."Role" OWNER TO squads;

--
-- Name: ScoreDataType; Type: TYPE; Schema: public; Owner: squads
--

CREATE TYPE public."ScoreDataType" AS ENUM (
    'CATEGORICAL',
    'NUMERIC',
    'BOOLEAN'
);


ALTER TYPE public."ScoreDataType" OWNER TO squads;

--
-- Name: ScoreSource; Type: TYPE; Schema: public; Owner: squads
--

CREATE TYPE public."ScoreSource" AS ENUM (
    'ANNOTATION',
    'API',
    'EVAL'
);


ALTER TYPE public."ScoreSource" OWNER TO squads;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: Account; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public."Account" (
    id text NOT NULL,
    type text NOT NULL,
    provider text NOT NULL,
    "providerAccountId" text NOT NULL,
    refresh_token text,
    access_token text,
    expires_at integer,
    token_type text,
    scope text,
    id_token text,
    session_state text,
    user_id text NOT NULL,
    expires_in integer,
    ext_expires_in integer,
    refresh_token_expires_in integer,
    created_at integer
);


ALTER TABLE public."Account" OWNER TO squads;

--
-- Name: Session; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public."Session" (
    id text NOT NULL,
    expires timestamp(3) without time zone NOT NULL,
    session_token text NOT NULL,
    user_id text NOT NULL
);


ALTER TABLE public."Session" OWNER TO squads;

--
-- Name: _prisma_migrations; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public._prisma_migrations (
    id character varying(36) NOT NULL,
    checksum character varying(64) NOT NULL,
    finished_at timestamp with time zone,
    migration_name character varying(255) NOT NULL,
    logs text,
    rolled_back_at timestamp with time zone,
    started_at timestamp with time zone DEFAULT now() NOT NULL,
    applied_steps_count integer DEFAULT 0 NOT NULL
);


ALTER TABLE public._prisma_migrations OWNER TO squads;

--
-- Name: annotation_queue_items; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.annotation_queue_items (
    id text NOT NULL,
    queue_id text NOT NULL,
    object_id text NOT NULL,
    object_type public."AnnotationQueueObjectType" NOT NULL,
    status public."AnnotationQueueStatus" DEFAULT 'PENDING'::public."AnnotationQueueStatus" NOT NULL,
    locked_at timestamp(3) without time zone,
    locked_by_user_id text,
    annotator_user_id text,
    completed_at timestamp(3) without time zone,
    project_id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.annotation_queue_items OWNER TO squads;

--
-- Name: annotation_queues; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.annotation_queues (
    id text NOT NULL,
    name text NOT NULL,
    description text,
    score_config_ids text[] DEFAULT ARRAY[]::text[],
    project_id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.annotation_queues OWNER TO squads;

--
-- Name: api_keys; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.api_keys (
    id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    note text,
    public_key text NOT NULL,
    hashed_secret_key text NOT NULL,
    display_secret_key text NOT NULL,
    last_used_at timestamp(3) without time zone,
    expires_at timestamp(3) without time zone,
    project_id text NOT NULL,
    fast_hashed_secret_key text
);


ALTER TABLE public.api_keys OWNER TO squads;

--
-- Name: audit_logs; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.audit_logs (
    id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    user_id text NOT NULL,
    project_id text,
    resource_type text NOT NULL,
    resource_id text NOT NULL,
    action text NOT NULL,
    before text,
    after text,
    org_id text NOT NULL,
    user_org_role text NOT NULL,
    user_project_role text
);


ALTER TABLE public.audit_logs OWNER TO squads;

--
-- Name: background_migrations; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.background_migrations (
    id text NOT NULL,
    name text NOT NULL,
    script text NOT NULL,
    args jsonb NOT NULL,
    finished_at timestamp(3) without time zone,
    failed_at timestamp(3) without time zone,
    failed_reason text,
    worker_id text,
    locked_at timestamp(3) without time zone,
    state jsonb DEFAULT '{}'::jsonb NOT NULL
);


ALTER TABLE public.background_migrations OWNER TO squads;

--
-- Name: batch_exports; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.batch_exports (
    id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    project_id text NOT NULL,
    user_id text NOT NULL,
    finished_at timestamp(3) without time zone,
    expires_at timestamp(3) without time zone,
    name text NOT NULL,
    status text NOT NULL,
    query jsonb NOT NULL,
    format text NOT NULL,
    url text,
    log text
);


ALTER TABLE public.batch_exports OWNER TO squads;

--
-- Name: comments; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.comments (
    id text NOT NULL,
    project_id text NOT NULL,
    object_type public."CommentObjectType" NOT NULL,
    object_id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    content text NOT NULL,
    author_user_id text
);


ALTER TABLE public.comments OWNER TO squads;

--
-- Name: cron_jobs; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.cron_jobs (
    name text NOT NULL,
    last_run timestamp(3) without time zone,
    state text,
    job_started_at timestamp(3) without time zone
);


ALTER TABLE public.cron_jobs OWNER TO squads;

--
-- Name: dataset_items; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.dataset_items (
    id text NOT NULL,
    input jsonb,
    expected_output jsonb,
    source_observation_id text,
    dataset_id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    status public."DatasetStatus" DEFAULT 'ACTIVE'::public."DatasetStatus" NOT NULL,
    source_trace_id text,
    metadata jsonb,
    project_id text NOT NULL
);


ALTER TABLE public.dataset_items OWNER TO squads;

--
-- Name: dataset_run_items; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.dataset_run_items (
    id text NOT NULL,
    dataset_run_id text NOT NULL,
    dataset_item_id text NOT NULL,
    observation_id text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    trace_id text NOT NULL,
    project_id text NOT NULL
);


ALTER TABLE public.dataset_run_items OWNER TO squads;

--
-- Name: dataset_runs; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.dataset_runs (
    id text NOT NULL,
    name text NOT NULL,
    dataset_id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    metadata jsonb,
    description text,
    project_id text NOT NULL
);


ALTER TABLE public.dataset_runs OWNER TO squads;

--
-- Name: datasets; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.datasets (
    id text NOT NULL,
    name text NOT NULL,
    project_id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    description text,
    metadata jsonb
);


ALTER TABLE public.datasets OWNER TO squads;

--
-- Name: eval_templates; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.eval_templates (
    id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    project_id text NOT NULL,
    name text NOT NULL,
    version integer NOT NULL,
    prompt text NOT NULL,
    model text NOT NULL,
    model_params jsonb NOT NULL,
    vars text[] DEFAULT ARRAY[]::text[],
    output_schema jsonb NOT NULL,
    provider text NOT NULL
);


ALTER TABLE public.eval_templates OWNER TO squads;

--
-- Name: events; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.events (
    id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    project_id text NOT NULL,
    data jsonb NOT NULL,
    url text,
    method text,
    headers jsonb DEFAULT '{}'::jsonb NOT NULL
);


ALTER TABLE public.events OWNER TO squads;

--
-- Name: job_configurations; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.job_configurations (
    id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    project_id text NOT NULL,
    job_type public."JobType" NOT NULL,
    eval_template_id text,
    score_name text NOT NULL,
    filter jsonb NOT NULL,
    target_object text NOT NULL,
    variable_mapping jsonb NOT NULL,
    sampling numeric(65,30) NOT NULL,
    delay integer NOT NULL,
    status public."JobConfigState" DEFAULT 'ACTIVE'::public."JobConfigState" NOT NULL
);


ALTER TABLE public.job_configurations OWNER TO squads;

--
-- Name: job_executions; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.job_executions (
    id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    project_id text NOT NULL,
    job_configuration_id text NOT NULL,
    status public."JobExecutionStatus" NOT NULL,
    start_time timestamp(3) without time zone,
    end_time timestamp(3) without time zone,
    error text,
    job_input_trace_id text,
    job_output_score_id text,
    job_input_dataset_item_id text,
    job_input_observation_id text
);


ALTER TABLE public.job_executions OWNER TO squads;

--
-- Name: llm_api_keys; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.llm_api_keys (
    id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    provider text NOT NULL,
    display_secret_key text NOT NULL,
    secret_key text NOT NULL,
    project_id text NOT NULL,
    base_url text,
    adapter text NOT NULL,
    custom_models text[] DEFAULT '{}'::text[] NOT NULL,
    with_default_models boolean DEFAULT true NOT NULL,
    config jsonb
);


ALTER TABLE public.llm_api_keys OWNER TO squads;

--
-- Name: media; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.media (
    id text NOT NULL,
    sha_256_hash character(44) NOT NULL,
    project_id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    uploaded_at timestamp(3) without time zone,
    upload_http_status integer,
    upload_http_error text,
    bucket_path text NOT NULL,
    bucket_name text NOT NULL,
    content_type text NOT NULL,
    content_length bigint NOT NULL
);


ALTER TABLE public.media OWNER TO squads;

--
-- Name: membership_invitations; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.membership_invitations (
    id text NOT NULL,
    email text NOT NULL,
    project_id text,
    invited_by_user_id text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    org_id text NOT NULL,
    org_role public."Role" NOT NULL,
    project_role public."Role"
);


ALTER TABLE public.membership_invitations OWNER TO squads;

--
-- Name: models; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.models (
    id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    project_id text,
    model_name text NOT NULL,
    match_pattern text NOT NULL,
    start_date timestamp(3) without time zone,
    input_price numeric(65,30),
    output_price numeric(65,30),
    total_price numeric(65,30),
    unit text,
    tokenizer_config jsonb,
    tokenizer_id text
);


ALTER TABLE public.models OWNER TO squads;

--
-- Name: observation_media; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.observation_media (
    id text NOT NULL,
    project_id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    media_id text NOT NULL,
    trace_id text NOT NULL,
    observation_id text NOT NULL,
    field text NOT NULL
);


ALTER TABLE public.observation_media OWNER TO squads;

--
-- Name: observations; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.observations (
    id text NOT NULL,
    name text,
    start_time timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    end_time timestamp(3) without time zone,
    parent_observation_id text,
    type public."ObservationType" NOT NULL,
    trace_id text,
    metadata jsonb,
    model text,
    "modelParameters" jsonb,
    input jsonb,
    output jsonb,
    level public."ObservationLevel" DEFAULT 'DEFAULT'::public."ObservationLevel" NOT NULL,
    status_message text,
    completion_start_time timestamp(3) without time zone,
    completion_tokens integer DEFAULT 0 NOT NULL,
    prompt_tokens integer DEFAULT 0 NOT NULL,
    total_tokens integer DEFAULT 0 NOT NULL,
    version text,
    project_id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    unit text,
    prompt_id text,
    input_cost numeric(65,30),
    output_cost numeric(65,30),
    total_cost numeric(65,30),
    internal_model text,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    calculated_input_cost numeric(65,30),
    calculated_output_cost numeric(65,30),
    calculated_total_cost numeric(65,30),
    internal_model_id text
);


ALTER TABLE public.observations OWNER TO squads;

--
-- Name: prompts; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.prompts (
    id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    project_id text NOT NULL,
    created_by text NOT NULL,
    name text NOT NULL,
    version integer NOT NULL,
    is_active boolean,
    config json DEFAULT '{}'::json NOT NULL,
    prompt jsonb NOT NULL,
    type text DEFAULT 'text'::text NOT NULL,
    tags text[] DEFAULT ARRAY[]::text[],
    labels text[] DEFAULT ARRAY[]::text[]
);


ALTER TABLE public.prompts OWNER TO squads;

--
-- Name: observations_view; Type: VIEW; Schema: public; Owner: squads
--

CREATE VIEW public.observations_view AS
 SELECT o.id,
    o.name,
    o.start_time,
    o.end_time,
    o.parent_observation_id,
    o.type,
    o.trace_id,
    o.metadata,
    o.model,
    o."modelParameters",
    o.input,
    o.output,
    o.level,
    o.status_message,
    o.completion_start_time,
    o.completion_tokens,
    o.prompt_tokens,
    o.total_tokens,
    o.version,
    o.project_id,
    o.created_at,
    o.updated_at,
    o.unit,
    o.prompt_id,
    p.name AS prompt_name,
    p.version AS prompt_version,
    o.input_cost,
    o.output_cost,
    o.total_cost,
    o.internal_model,
    m.id AS model_id,
    m.start_date AS model_start_date,
    m.input_price,
    m.output_price,
    m.total_price,
    m.tokenizer_config,
        CASE
            WHEN ((o.calculated_input_cost IS NULL) AND (o.input_cost IS NULL) AND (o.output_cost IS NULL) AND (o.total_cost IS NULL)) THEN ((o.prompt_tokens)::numeric * m.input_price)
            ELSE COALESCE(o.calculated_input_cost, o.input_cost)
        END AS calculated_input_cost,
        CASE
            WHEN ((o.calculated_output_cost IS NULL) AND (o.input_cost IS NULL) AND (o.output_cost IS NULL) AND (o.total_cost IS NULL)) THEN ((o.completion_tokens)::numeric * m.output_price)
            ELSE COALESCE(o.calculated_output_cost, o.output_cost)
        END AS calculated_output_cost,
        CASE
            WHEN ((o.calculated_total_cost IS NULL) AND (o.input_cost IS NULL) AND (o.output_cost IS NULL) AND (o.total_cost IS NULL)) THEN
            CASE
                WHEN ((m.total_price IS NOT NULL) AND (o.total_tokens IS NOT NULL)) THEN (m.total_price * (o.total_tokens)::numeric)
                ELSE (((o.prompt_tokens)::numeric * m.input_price) + ((o.completion_tokens)::numeric * m.output_price))
            END
            ELSE COALESCE(o.calculated_total_cost, o.total_cost)
        END AS calculated_total_cost,
        CASE
            WHEN (o.end_time IS NULL) THEN NULL::double precision
            ELSE ((EXTRACT(epoch FROM o.end_time) - EXTRACT(epoch FROM o.start_time)))::double precision
        END AS latency,
        CASE
            WHEN ((o.completion_start_time IS NOT NULL) AND (o.start_time IS NOT NULL)) THEN (EXTRACT(epoch FROM (o.completion_start_time - o.start_time)))::double precision
            ELSE NULL::double precision
        END AS time_to_first_token
   FROM ((public.observations o
     LEFT JOIN LATERAL ( SELECT models.id,
            models.created_at,
            models.updated_at,
            models.project_id,
            models.model_name,
            models.match_pattern,
            models.start_date,
            models.input_price,
            models.output_price,
            models.total_price,
            models.unit,
            models.tokenizer_config,
            models.tokenizer_id
           FROM public.models
          WHERE (((models.project_id = o.project_id) OR (models.project_id IS NULL)) AND (models.model_name = o.internal_model) AND ((models.start_date < o.start_time) OR (models.start_date IS NULL)) AND (o.unit = models.unit))
          ORDER BY models.project_id, models.start_date DESC NULLS LAST
         LIMIT 1) m ON (true))
     LEFT JOIN LATERAL ( SELECT prompts.id,
            prompts.created_at,
            prompts.updated_at,
            prompts.project_id,
            prompts.created_by,
            prompts.name,
            prompts.version,
            prompts.is_active,
            prompts.config,
            prompts.prompt,
            prompts.type,
            prompts.tags,
            prompts.labels
           FROM public.prompts
          WHERE ((prompts.id = o.prompt_id) AND (prompts.project_id = o.project_id))
         LIMIT 1) p ON (true));


ALTER VIEW public.observations_view OWNER TO squads;

--
-- Name: organization_memberships; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.organization_memberships (
    id text NOT NULL,
    org_id text NOT NULL,
    user_id text NOT NULL,
    role public."Role" NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.organization_memberships OWNER TO squads;

--
-- Name: organizations; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.organizations (
    id text NOT NULL,
    name text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    cloud_config jsonb
);


ALTER TABLE public.organizations OWNER TO squads;

--
-- Name: posthog_integrations; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.posthog_integrations (
    project_id text NOT NULL,
    encrypted_posthog_api_key text NOT NULL,
    posthog_host_name text NOT NULL,
    last_sync_at timestamp(3) without time zone,
    enabled boolean NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.posthog_integrations OWNER TO squads;

--
-- Name: prices; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.prices (
    id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    model_id text NOT NULL,
    usage_type text NOT NULL,
    price numeric(65,30) NOT NULL
);


ALTER TABLE public.prices OWNER TO squads;

--
-- Name: project_memberships; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.project_memberships (
    project_id text NOT NULL,
    user_id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    org_membership_id text NOT NULL,
    role public."Role" NOT NULL
);


ALTER TABLE public.project_memberships OWNER TO squads;

--
-- Name: projects; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.projects (
    id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    name text NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    org_id text NOT NULL
);


ALTER TABLE public.projects OWNER TO squads;

--
-- Name: score_configs; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.score_configs (
    id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    project_id text NOT NULL,
    name text NOT NULL,
    data_type public."ScoreDataType" NOT NULL,
    is_archived boolean DEFAULT false NOT NULL,
    min_value double precision,
    max_value double precision,
    categories jsonb,
    description text
);


ALTER TABLE public.score_configs OWNER TO squads;

--
-- Name: scores; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.scores (
    id text NOT NULL,
    "timestamp" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    name text NOT NULL,
    value double precision,
    observation_id text,
    trace_id text NOT NULL,
    comment text,
    source public."ScoreSource" NOT NULL,
    project_id text NOT NULL,
    author_user_id text,
    config_id text,
    data_type public."ScoreDataType" DEFAULT 'NUMERIC'::public."ScoreDataType" NOT NULL,
    string_value text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    queue_id text
);


ALTER TABLE public.scores OWNER TO squads;

--
-- Name: sso_configs; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.sso_configs (
    domain text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    auth_provider text NOT NULL,
    auth_config jsonb
);


ALTER TABLE public.sso_configs OWNER TO squads;

--
-- Name: trace_media; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.trace_media (
    id text NOT NULL,
    project_id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    media_id text NOT NULL,
    trace_id text NOT NULL,
    field text NOT NULL
);


ALTER TABLE public.trace_media OWNER TO squads;

--
-- Name: trace_sessions; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.trace_sessions (
    id text NOT NULL,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    project_id text NOT NULL,
    bookmarked boolean DEFAULT false NOT NULL,
    public boolean DEFAULT false NOT NULL
);


ALTER TABLE public.trace_sessions OWNER TO squads;

--
-- Name: traces; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.traces (
    id text NOT NULL,
    "timestamp" timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    name text,
    project_id text NOT NULL,
    metadata jsonb,
    external_id text,
    user_id text,
    release text,
    version text,
    public boolean DEFAULT false NOT NULL,
    bookmarked boolean DEFAULT false NOT NULL,
    input jsonb,
    output jsonb,
    session_id text,
    tags text[] DEFAULT ARRAY[]::text[],
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL
);


ALTER TABLE public.traces OWNER TO squads;

--
-- Name: traces_view; Type: VIEW; Schema: public; Owner: squads
--

CREATE VIEW public.traces_view AS
 WITH observations_metrics AS (
         SELECT o_1.trace_id,
            o_1.project_id,
            ((EXTRACT(epoch FROM COALESCE(max(o_1.end_time), max(o_1.start_time))))::double precision - (EXTRACT(epoch FROM min(o_1.start_time)))::double precision) AS duration
           FROM public.observations o_1
          GROUP BY o_1.project_id, o_1.trace_id
        )
 SELECT t.id,
    t."timestamp",
    t.name,
    t.project_id,
    t.metadata,
    t.external_id,
    t.user_id,
    t.release,
    t.version,
    t.public,
    t.bookmarked,
    t.input,
    t.output,
    t.session_id,
    t.tags,
    t.created_at,
    t.updated_at,
    o.duration
   FROM (public.traces t
     LEFT JOIN observations_metrics o ON (((t.id = o.trace_id) AND (t.project_id = o.project_id))));


ALTER VIEW public.traces_view OWNER TO squads;

--
-- Name: users; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.users (
    id text NOT NULL,
    name text,
    email text,
    email_verified timestamp(3) without time zone,
    password text,
    image text,
    created_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    updated_at timestamp(3) without time zone DEFAULT CURRENT_TIMESTAMP NOT NULL,
    feature_flags text[] DEFAULT ARRAY[]::text[],
    admin boolean DEFAULT false NOT NULL
);


ALTER TABLE public.users OWNER TO squads;

--
-- Name: verification_tokens; Type: TABLE; Schema: public; Owner: squads
--

CREATE TABLE public.verification_tokens (
    identifier text NOT NULL,
    token text NOT NULL,
    expires timestamp(3) without time zone NOT NULL
);


ALTER TABLE public.verification_tokens OWNER TO squads;

--
-- Data for Name: Account; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public."Account" (id, type, provider, "providerAccountId", refresh_token, access_token, expires_at, token_type, scope, id_token, session_state, user_id, expires_in, ext_expires_in, refresh_token_expires_in, created_at) FROM stdin;
\.


--
-- Data for Name: Session; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public."Session" (id, expires, session_token, user_id) FROM stdin;
\.


--
-- Data for Name: _prisma_migrations; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public._prisma_migrations (id, checksum, finished_at, migration_name, logs, rolled_back_at, started_at, applied_steps_count) FROM stdin;
aa92e802-7b70-4e34-a1e7-f09999512925	c418394abc6167c883f1456639e995ab5054a8257e8dba37b7a95c76ba59af0c	2026-01-04 12:32:01.597614+00	20230710200816_scores_add_comment	\N	\N	2026-01-04 12:32:01.596785+00	1
35d12d49-f343-413f-b6ac-3d8831d2b84f	45fc679b7dbbe0f2954623bfe4e29932374cdc3167f8395728ef5c20115e5665	2026-01-04 12:32:01.52104+00	20230518191501_init	\N	\N	2026-01-04 12:32:01.508458+00	1
206155b3-61ad-4136-ab9c-68f2aa9a7f88	6462cebefe054956e2fa9948435590bd4dae0d58f75cf2ecba57059f2c0909f8	2026-01-04 12:32:01.582086+00	20230623172401_observation_add_level_and_status_message	\N	\N	2026-01-04 12:32:01.580869+00	1
2a577c8c-e591-4ad9-b8b3-15024ef7bb87	b9c79e332b90d28b1711534e53622f297a6a888aa7d6c1c1832185d1fef2c929	2026-01-04 12:32:01.526673+00	20230518193415_add_observaionts_and_traces	\N	\N	2026-01-04 12:32:01.521419+00	1
f64680e6-2a87-4932-8eed-6345233e881f	2f2fd22c3cc8bd21f6f23c88b7d5ef34674431520d0e55a37f8239e4a58afebd	2026-01-04 12:32:01.528658+00	20230518193521_changes	\N	\N	2026-01-04 12:32:01.52698+00	1
1fe05e13-1a32-48ea-8a2b-bc4b9962040d	d2c9bf829418360a44d1022156aaa8e95df92c940b5dfe962f8a7f7260cb5520	2026-01-04 12:32:01.532736+00	20230522092340_add_metrics_and_observation_types	\N	\N	2026-01-04 12:32:01.529197+00	1
06f9af93-b14f-4264-b980-b04c42343514	2480f771a6b4dea1f541c0b231784e5cebf2c443ac7636da6a411c4914f1cbd4	2026-01-04 12:32:01.584197+00	20230626095337_external_trace_id	\N	\N	2026-01-04 12:32:01.582579+00	1
6f10cf49-51fd-4ec7-a22b-35f5551f72a4	28c59a2bd9b846d914083efdc1b51eb96a1db66af370b3dddd5040a57ec9088b	2026-01-04 12:32:01.534073+00	20230522094431_endtime_optional	\N	\N	2026-01-04 12:32:01.533056+00	1
38c9e179-810e-4dd7-901f-ab95bc58c88f	755b1309b9c12e892f5a5f6db4e14f15b2d77ab61f76baab4c3621ea5e94fa6c	2026-01-04 12:32:01.535688+00	20230522131516_default_timestamp	\N	\N	2026-01-04 12:32:01.534394+00	1
3f6564d3-ef30-47e4-845d-0bb472d0ef02	7f995c9ff2b7e3f70bb5eeebb2108552feaf5f8a51154727c36db9466f0e3ec4	2026-01-04 12:32:01.617286+00	20230731162154_score_value_float	\N	\N	2026-01-04 12:32:01.613995+00	1
60f76369-0595-4f06-865d-e0eb1bbe18bb	66607eae9ccdfb92f30d859bcff0838e5df64c76da43ffbb25a65845dc63234e	2026-01-04 12:32:01.540627+00	20230523082455_rename_metrics_to_gradings	\N	\N	2026-01-04 12:32:01.536021+00	1
ae98d148-a484-4fd8-a64b-f3f3c1763b0c	e5b55a82f4be9d623abac6ef0d9d00da2bf437f60454ed46bb1defa30e388692	2026-01-04 12:32:01.586084+00	20230705160335_add_created_updated_timestamps	\N	\N	2026-01-04 12:32:01.584679+00	1
fe636b6e-7c57-4a09-90be-0b29e087a2ca	ff4107185d8f98b9d850e571a464bb806dade0f482984b3e29c019cb4d51397c	2026-01-04 12:32:01.545677+00	20230523084523_rename_to_score	\N	\N	2026-01-04 12:32:01.541218+00	1
3f3b98dc-9e85-47e9-9da0-d5f7ef097024	ab80a534dfa4779eeae4ae5aeac192eea19b283671d6083c8f112e3c8a4229df	2026-01-04 12:32:01.54674+00	20230529140133_user_add_pw	\N	\N	2026-01-04 12:32:01.545955+00	1
87067b20-b274-4047-a506-689a10c8ce74	f7c8e195215bf8a82ff89093a94aef748c209361aa05a48273f2084c49f05cd6	2026-01-04 12:32:01.5995+00	20230711104810_traces_add_index	\N	\N	2026-01-04 12:32:01.598022+00	1
c5b8d80f-16e8-433d-b24d-4a9ac6e077d9	f0ef0a5663ceecf04816edea38d3fe93cf07f4c8031d2b7e185ec2e5fe39f0fa	2026-01-04 12:32:01.571087+00	20230530204241_auth_api_ui	\N	\N	2026-01-04 12:32:01.547051+00	1
beea3ab0-33a0-4a0b-be99-6be6b75767c9	83f6a1d39c744faecc145e812f8ecca54267ac363f6315aa8afc3d890bf1f02d	2026-01-04 12:32:01.587134+00	20230706195819_add_completion_start_time	\N	\N	2026-01-04 12:32:01.586369+00	1
2617c125-90c7-4439-a75a-eee003d2f629	5e2e9d168251bab10d33e5f65a848c48d5f4ab762427ddd0f81e907c3339eb9a	2026-01-04 12:32:01.573082+00	20230618125818_remove_status_from_trace	\N	\N	2026-01-04 12:32:01.571636+00	1
63c4f6af-7de3-4abd-ab3b-62354e36c5f2	a7808d643321e4bf3d0628b256abb7d088e964c48698af6fdd7f32969dfd41aa	2026-01-04 12:32:01.578708+00	20230620181114_restructure	\N	\N	2026-01-04 12:32:01.573754+00	1
0026c0d9-4163-414a-b42b-6477c8d4361e	025c499c8b6f13676087e2e419671177a85a3ebad3a53cf84c7f70b0cfe01efe	2026-01-04 12:32:01.580477+00	20230622114254_new_oservations	\N	\N	2026-01-04 12:32:01.579009+00	1
12dc00e6-af02-44e7-b2ee-b2630600a6b7	ffbe75ad538d26b0864f8b8915115e0fbdd56fbc93a4d3a634d53488b741d403	2026-01-04 12:32:01.588916+00	20230707132314_traces_project_id_index	\N	\N	2026-01-04 12:32:01.587418+00	1
8446491f-ee44-46ae-84f1-ab4bd7483e4d	4cd20328eb9aa4ce2f0fe7dab5e00c412215e2c4423902d79cdebd7b0e2325f0	2026-01-04 12:32:01.611313+00	20230720164603_migrate_tokens	\N	\N	2026-01-04 12:32:01.610457+00	1
746f1e1a-e2b7-4b19-94ed-43ba03c51357	362123c958d4fd06df3c816b74b4336ad2373f1505be12c84046e1364dd9dc10	2026-01-04 12:32:01.590787+00	20230707133415_user_add_email_index	\N	\N	2026-01-04 12:32:01.589333+00	1
ff585a10-3623-41c6-972f-7f86232a2e5b	5755c1c8449e6a74016e9e7e42acc446746a3c41f21e07c317a66417fd399d94	2026-01-04 12:32:01.601284+00	20230711110517_memberships_add_userid_index	\N	\N	2026-01-04 12:32:01.599929+00	1
3fdd0978-1ea0-4383-8d6e-0235a2d8c4a6	e7de5bcadea82b38002ead42a8e99f532e5fe2c178ba53d5954ef2c60a0115b3	2026-01-04 12:32:01.59457+00	20230710105741_added_indices	\N	\N	2026-01-04 12:32:01.591235+00	1
1e83fa05-d60a-43dc-a8f2-618b7c69082a	18a5a7ffe2b0ec8c008a1336826e3e07525f42a27e981f0a778533947b09e92d	2026-01-04 12:32:01.596533+00	20230710114928_traces_add_user_id	\N	\N	2026-01-04 12:32:01.594857+00	1
4510cd9c-9e15-4cb8-aa8e-4952dcc75088	225ccf9170a395e34586c954db9c71b84f4300a07ef67e5ff116d2d08f80f37f	2026-01-04 12:32:01.607326+00	20230711112235_fix_indices	\N	\N	2026-01-04 12:32:01.601555+00	1
19716d77-431f-470e-912c-df71e804a388	9994a7038fc3ba73d3b5e833ded5825ec58505918d6b4eca646dbfca60a899b8	2026-01-04 12:32:01.61256+00	20230720172051_tokens_non_null	\N	\N	2026-01-04 12:32:01.611609+00	1
e66d99f0-e294-4713-b802-d81aa559b27c	502d73e77f606982c12150e119f9214a7d8116d3d4d947ea37130d6aaf9280cd	2026-01-04 12:32:01.608585+00	20230717190411_users_feature_flags	\N	\N	2026-01-04 12:32:01.607657+00	1
73faee46-253b-4ca2-8b64-cb7ef05785b2	9d3edea83f7e43616f70059fd0dbe6236133ac5fcd9883ac59b298e97fcd2e68	2026-01-04 12:32:01.61004+00	20230720162550_tokens	\N	\N	2026-01-04 12:32:01.609015+00	1
38be1754-03f5-4125-ae16-3e1ae17085b1	7c025190192fb785a7f3728ebab61bb167f3be07233341678c640bd31360fce5	2026-01-04 12:32:01.622578+00	20230810191452_traceid_nullable_on_observations	\N	\N	2026-01-04 12:32:01.621875+00	1
1947bd76-e91e-4a98-9172-618f5bf8c0c5	882b8cd48edf35b50633d13833aa0c8b92f70b707c3fc035fe0e59d2355a3a95	2026-01-04 12:32:01.613583+00	20230721111651_drop_usage_json	\N	\N	2026-01-04 12:32:01.612824+00	1
85b958e4-e31f-4a9d-9405-6ba265f10dcd	056d2e25ef8ebb7b2b7eee99a708ab8feffa348896301c8a1a67524e3c2fddf8	2026-01-04 12:32:01.621485+00	20230809132331_add_project_id_to_observations	\N	\N	2026-01-04 12:32:01.620114+00	1
1221396d-2eaa-4535-802b-69ca7a18a115	05604cd4b32a7e41e21a314c7e78fd1b5883a9582acb5f4308ee7053af9707d7	2026-01-04 12:32:01.618423+00	20230803093326_add_release_and_version	\N	\N	2026-01-04 12:32:01.617685+00	1
1864220a-51f2-46ad-9f82-d0217430a97a	ef6d52cd7eae4e95cf21b942289d9efb69e7f60eb5d3ca281d252c54e2b77ede	2026-01-04 12:32:01.619839+00	20230809093636_remove_foreign_keys	\N	\N	2026-01-04 12:32:01.618644+00	1
465b9540-ebcf-4963-a02b-52b76fb960ff	f409d263846f578bba696959b5ebfaa60a9534a407c6ad8c8fc32604ab7adfd1	2026-01-04 12:32:01.623837+00	20230810191453_project_id_not_null	\N	\N	2026-01-04 12:32:01.62298+00	1
db1a6bcf-c748-460c-944d-b398df186ecf	f998a3d872a1056949638870ce35fedb364d37297a784ecbcd1f95faf04a4c5c	2026-01-04 12:32:01.624874+00	20230814184705_add_viewer_membership_role	\N	\N	2026-01-04 12:32:01.624116+00	1
b028b98b-726c-4ba7-9190-f040fd56ab09	51ccaa1ee0828dcb0cf731b019486c2f39c5b1bdd09046ab90f9ba6ec13be1af	2026-01-04 12:32:01.628989+00	20230901155252_add_pricings_table	\N	\N	2026-01-04 12:32:01.62513+00	1
63b97f81-d679-4832-b359-9faf38c23511	5b8a5e3d5880fa10be8005ca6e4d682104dae3f816e162c3db94c41753a8e1c5	2026-01-04 12:32:01.63136+00	20230901155336_add_pricing_data	\N	\N	2026-01-04 12:32:01.63023+00	1
aec3f5bc-c459-4f25-9e8a-fede2b5e1320	e31a4c1059dcbabbdc2ab6aecb50328bef42e809ed206485aba37c437c5cebc2	2026-01-04 12:32:01.633745+00	20230907204921_add_cron_jobs_table	\N	\N	2026-01-04 12:32:01.631779+00	1
93d0c731-50ab-4cd3-b02b-a20c74d6efe1	800d6b5782b4564cfa092fd57f42ec2283537d439f167419211669aaa7df3ee2	2026-01-04 12:32:01.691676+00	20231119171940_bookmarked	\N	\N	2026-01-04 12:32:01.690898+00	1
9665193e-08a7-485d-99a9-b5ebb64725b2	285bbb0b1c1ad7b8ee2d29ae7477b3f5b1b0e53fc58e9d75a287aaac715d498b	2026-01-04 12:32:01.634807+00	20230907225603_projects_updated_at	\N	\N	2026-01-04 12:32:01.634001+00	1
c87efb36-cb01-4585-89e8-c6d331196402	578777f46933e33a0dc8e7c78f054c86dd0ed1413f67dc2d6334365cfda4c6bb	2026-01-04 12:32:01.670241+00	20231018130032_add_per_1000_chars_pricing	\N	\N	2026-01-04 12:32:01.669579+00	1
e877274c-8309-4393-bb5e-2a62f0a784ee	d11aeff0b05af374c3306cdb12cc18afb7f73c5b8ce2c50757745ce5775340e2	2026-01-04 12:32:01.636619+00	20230907225604_api_keys_publishable_to_public	\N	\N	2026-01-04 12:32:01.635186+00	1
207c781d-79b8-4d00-b77f-68ec449b5a69	378a5dd5ba691270826895506d53e8a6acc4ebba29f8226dfa0d78e698040c5e	2026-01-04 12:32:01.637465+00	20230910164603_cron_add_state	\N	\N	2026-01-04 12:32:01.63685+00	1
59b2c547-1f19-4ab4-b0b8-08941b4041d7	00cea39de0d75e817cfadcd95f852d4a84e00c1f67930d518ae4d452c93ac177	2026-01-04 12:32:01.684822+00	20231110012457_observation_created_at	\N	\N	2026-01-04 12:32:01.683917+00	1
9ba65f86-3ba3-4248-ac6b-64c1c4f3c625	d4af17aef307dba854b4b896df6f998cef8ac211fb792b7e90c7fe6fa4a9e4c3	2026-01-04 12:32:01.639303+00	20230912115644_add_trace_public_bool	\N	\N	2026-01-04 12:32:01.638533+00	1
86e9d719-bcb7-47f9-99ad-bcc0de5b9770	c087cf267a4c8b52ec4cebf0612b840d2136475e4776e9206778830256ce3f32	2026-01-04 12:32:01.673819+00	20231019094815_add_additional_secret_key_column	\N	\N	2026-01-04 12:32:01.670488+00	1
af907fe8-1044-4926-9221-be299b78034a	2026ed8d4e73d7d09741dbedf1fe73233e624f3e7f81b2a2b9243f415168ebb2	2026-01-04 12:32:01.641677+00	20230918180320_add_indices	\N	\N	2026-01-04 12:32:01.639548+00	1
6978d5db-9ecb-4444-a526-025aaf1c7bb8	6bfdc95391ba091dc9d96899dbe7f967814cf42eb6388b664d9d76d8982add70	2026-01-04 12:32:01.643284+00	20230922030325_add_observation_index	\N	\N	2026-01-04 12:32:01.642058+00	1
094f2b73-17d9-4ca7-b6a8-77ff0aef9771	ea9794f2d79f49b88ab95b90335fe97cd7ccc3d7f1dd156259a5e5aa1c107043	2026-01-04 12:32:01.653163+00	20230924232619_datasets_init	\N	\N	2026-01-04 12:32:01.643534+00	1
a6019103-b764-4fc7-a2a7-1439d0fe8df4	44810e0e19455ef071bec618d10951ba956e7a112631eb3f4c313fe903db7267	2026-01-04 12:32:01.675883+00	20231021182825_user_emails_all_lowercase	\N	\N	2026-01-04 12:32:01.675161+00	1
4c46a58b-f5c1-4d4c-94f9-5b50f62ea2ad	6db5841932092efa895afe4c027079a9c48ae252181c8e0c3985c6d08f96ba8a	2026-01-04 12:32:01.65603+00	20230924232620_datasets_continued	\N	\N	2026-01-04 12:32:01.653585+00	1
b3b18dce-0dfd-4e76-9104-7c633857d9ab	e8f8302423f78da25f0349a5da4083160f574c98ccc2b3e28f91d16cfa1ad499	2026-01-04 12:32:01.659086+00	20231004005909_add_parent_observation_id_index	\N	\N	2026-01-04 12:32:01.656296+00	1
99f91740-34c8-4afd-95a3-dfe9339dfdcf	8f1b13112f4627c886c705d33920578b19fea917471b7367191300eebef544fc	2026-01-04 12:32:01.660638+00	20231005064433_add_release_index	\N	\N	2026-01-04 12:32:01.659456+00	1
a7825a7a-ad0f-459d-893d-11cd0bae2325	6456651794d1f7215c7f39238725764948ce71b7df386639d2d4f58da2e93335	2026-01-04 12:32:01.676969+00	20231025153548_add_headers_to_events	\N	\N	2026-01-04 12:32:01.676141+00	1
94a70836-9892-46ab-8182-a6d7819bab00	dfeb488d9be2f37c669211d8fee91cc67d384eee1532512a00328195fd259e27	2026-01-04 12:32:01.664191+00	20231009095917_add_ondelete_cascade	\N	\N	2026-01-04 12:32:01.660904+00	1
dcdca12f-4b63-4355-9738-98f365fc5190	e08e3d28e1b13a6df4f7eb43bd81d427f86792a9235dfa123db11b67343c1d82	2026-01-04 12:32:01.666934+00	20231012161041_add_events_table	\N	\N	2026-01-04 12:32:01.664591+00	1
3356c743-a295-4c2e-a9a6-3354da303768	1074f270d9b48baa51d22c0c90218cdc47dc3338a5f0ea90bd72ef5ea5e2cf88	2026-01-04 12:32:01.686331+00	20231110012829_observation_created_at_index	\N	\N	2026-01-04 12:32:01.685083+00	1
5cae706e-9410-44cb-acd8-00433c2982f2	52d73a2c8f5927da07492f83ffc94ce4a3cdc93232be0291d0faf77bc5ba8eed	2026-01-04 12:32:01.669178+00	20231014131841_users_add_admin_flag	\N	\N	2026-01-04 12:32:01.667195+00	1
d7ffc537-0173-43d1-af59-6683932a14c0	cc2235e89e6815af4002bd4aa6941e16dd452efe9dc5d59ac0c390589160a7ac	2026-01-04 12:32:01.678889+00	20231030184329_events_add_index_on_projectid	\N	\N	2026-01-04 12:32:01.677366+00	1
32c7080e-e21d-48bd-abe6-6e1d7f4934ce	f5ef1377c36e5301cf312bb60c6bb647bdb3de2db1d847003b4cfd3e24ca9ccc	2026-01-04 12:32:01.68029+00	20231104004529_scores_add_index	\N	\N	2026-01-04 12:32:01.679181+00	1
c9150fb4-6e2f-467f-8809-7931b9265a53	9f5a355bf0c6c5fa36b37c898b338a234d43efa01d387eca439a95d674721ca2	2026-01-04 12:32:01.710998+00	20231230151856_add_prompt_table	\N	\N	2026-01-04 12:32:01.707028+00	1
5f0d508c-0cfc-40ca-920d-4862c4fb064d	2f634dc6a7e272e3715472968da531e23c9dda562d5d137e6bfe7195d51761ab	2026-01-04 12:32:01.68266+00	20231104005403_fkey_indicies	\N	\N	2026-01-04 12:32:01.680714+00	1
270fa80e-8047-404e-85a2-e2d1f751c571	3920714d62de04345531777f14fe9a02b8982890c93f0b57512c0ab55755ee79	2026-01-04 12:32:01.687999+00	20231112095703_observations_add_unique_constraint	\N	\N	2026-01-04 12:32:01.686711+00	1
ecc1b61d-7983-4e60-8d9e-a8c578a1e075	85bf236e16abc39747ea773383c06cd06208e2d147237beb0b20b48318397e7e	2026-01-04 12:32:01.683541+00	20231106213824_add_openai_models	\N	\N	2026-01-04 12:32:01.682904+00	1
eb280146-d2ae-42e3-80e4-ddc6b4eb1b61	0be96056b9709a8b7899d555e228d5c0098f1e6b358c6e016bb3843b7846b3f6	2026-01-04 12:32:01.697097+00	20231129013314_invites	\N	\N	2026-01-04 12:32:01.692059+00	1
d600981e-2e1d-470b-ac06-9b6ffcd48f8a	5881fcf2e0d44375b52e6228413774f3154ab9fab3492f8ff24a24c2f044033b	2026-01-04 12:32:01.689571+00	20231116005353_scores_unique_id_projectid	\N	\N	2026-01-04 12:32:01.688257+00	1
d3fec581-346b-4c19-81db-87e0b61ba10e	8fee27ef5b07ba63a31cf88aee365f6f9c66b8cb5a08492b7f19c2a1eef249e4	2026-01-04 12:32:01.690655+00	20231119171939_cron_add_job_started_at	\N	\N	2026-01-04 12:32:01.689944+00	1
87cba4a9-a7d5-4ea9-8022-8e6dcba54075	1b774d2ddbe9ae0f7cf8b60beaef0d27a6f5e8b09840e342ffd85c63c5de517d	2026-01-04 12:32:01.705801+00	20231223230007_cloud_config	\N	\N	2026-01-04 12:32:01.705012+00	1
0a2718a7-69ff-49f7-acaf-06404df40bab	401f5230ee1dccb765509321e8075652e71ae4ec28f5648a6b2ee151fc58d90b	2026-01-04 12:32:01.703185+00	20231130003317_trace_session_input_output	\N	\N	2026-01-04 12:32:01.69738+00	1
6efedb12-a288-466f-844c-13092ef7ffdb	f73f71a1a394677fb4ddd00cfe2238c40190f875525473d9ebf80f15fc89a2e7	2026-01-04 12:32:01.704622+00	20231204223505_add_unit_to_observations	\N	\N	2026-01-04 12:32:01.703617+00	1
b0d0f7dc-d507-4574-8050-63e92ee19133	14911fffc711830a28304af98b2c9fe31f5f78fb568281090a75f4f7958ba942	2026-01-04 12:32:01.706767+00	20231223230008_accounts_add_cols_azure_ad_auth	\N	\N	2026-01-04 12:32:01.706047+00	1
c5edc80a-621c-4f50-8aa9-5bb496e76e96	9f7ef155730980f10cf9c84fdcce91b80822a8ff1d7d35720b544f851397a0e5	2026-01-04 12:32:01.714442+00	20240104210051_add_model_indices	\N	\N	2026-01-04 12:32:01.712728+00	1
eb4d52b7-1a1a-4048-9ff2-3e1af07d9b06	7919b5dfcacec288b646f23c83f6adbf5f69eba50d2de4a35eb2b9d3029e4729	2026-01-04 12:32:01.712048+00	20240103135918_add_pricings	\N	\N	2026-01-04 12:32:01.711263+00	1
c5be4a54-213d-49d4-a1dd-9804117ada26	ed03d628f2755b0b16963a8d20b72440588a7ed57a4f1652d9b128e5dcfbf1b3	2026-01-04 12:32:01.716125+00	20240104210052_add_model_indices_pricing	\N	\N	2026-01-04 12:32:01.714684+00	1
a9a6ca19-1bff-48ac-a9a1-886fe4621a80	08918b17989f2bd0e36f80c5255042f807afe428186c68cf334fa01953153807	2026-01-04 12:32:01.717223+00	20240105010215_add_tags_in_traces	\N	\N	2026-01-04 12:32:01.716381+00	1
2f03b7f7-019b-4ccc-a792-da2992d39730	18fba86141a537df2fdf6bc8b8d8cd1abcdef25ca0dca43d1983fb23dac4db72	2026-01-04 12:32:01.718523+00	20240105170551_index_tags_in_traces	\N	\N	2026-01-04 12:32:01.717647+00	1
9e061da0-db6a-44cd-af6e-6175d4fce483	de4c1bc9e76dc2ad02e5cedc68bc20450c80307c64123469b925b1ba1787449c	2026-01-04 12:32:01.719732+00	20240106195340_drop_dataset_status	\N	\N	2026-01-04 12:32:01.718885+00	1
d97cb813-b8df-417e-a7db-9edd8c39d9ce	795187b23b16aceb796a10b5a43327cd3f767a0048f7ae8cb4d209695e49f18d	2026-01-04 12:32:01.756461+00	20240215234937_fix_observations_view	\N	\N	2026-01-04 12:32:01.754682+00	1
2d9d7d26-7e35-4444-a85b-451cc8c3b558	9d7148c925f6643b17c1aad933fce92bdcbc8fa2304eb97be11c0aa32747664a	2026-01-04 12:32:01.720718+00	20240111152124_add_gpt_35_pricing	\N	\N	2026-01-04 12:32:01.719984+00	1
d75d0f94-9667-4783-8bab-25309efe0d73	fcbff614561f2c09501be18aad566624e04bf390aef8c072596ac2b793d10cb7	2026-01-04 12:32:01.741998+00	20240130100110_usage_unit_nullable	\N	\N	2026-01-04 12:32:01.74117+00	1
4c49d23c-8357-4ad1-96e4-6ec13842b80e	9496ee3af1202cb3f9d6f0d4bb88c521e0e796a04bc8e02622718a63ba79b710	2026-01-04 12:32:01.721748+00	20240117151938_traces_remove_unique_id_external	\N	\N	2026-01-04 12:32:01.720964+00	1
938ed49c-63c9-499a-9874-eceb56508e96	c5919ee7870f36a7555024eb2256b3a28c8d978032dcd943047e5cff27a86cba	2026-01-04 12:32:01.723009+00	20240117165747_add_cost_to_observations	\N	\N	2026-01-04 12:32:01.722277+00	1
0e10c7c2-a573-4268-a6f4-2b27f97eb6f7	ad8869aea6b98159c54bd3f2fcfb4ee1114ba54a7bf5726378dc2edd6f8077eb	2026-01-04 12:32:01.725887+00	20240118204639_add_models_table	\N	\N	2026-01-04 12:32:01.7234+00	1
e2c61cf1-a728-493e-abff-b694026baa0c	c301dfa0db4367a4691bf520cb0c0b377b10e2ef4ca66f39f818284b23d0cfa2	2026-01-04 12:32:01.743179+00	20240130160110_claude_models	\N	\N	2026-01-04 12:32:01.742238+00	1
d276677d-2684-482c-98f3-b418d20e7725	7211b935cb3f52c11c7ebd0ac540bbbd01bb2010e51ad412d2956645c02724b7	2026-01-04 12:32:01.726796+00	20240118204936_add_internal_model	\N	\N	2026-01-04 12:32:01.726124+00	1
5c1b8fa0-7616-4540-b572-8df1a492a6c7	b79f2ca2011baa6604eec15e549996af3a10e396b706aff73b6ca36c08291d99	2026-01-04 12:32:01.728866+00	20240118204937_add_observations_view	\N	\N	2026-01-04 12:32:01.727039+00	1
398d1348-a36c-4d95-9bac-700eabf515a4	2ab605d386e52af31b6328f5542d63ec6a6b19db9bda8f2e4888a7de7154b2ae	2026-01-04 12:32:01.780513+00	20240304123642_traces_view_improvement	\N	\N	2026-01-04 12:32:01.778998+00	1
3a5b5cb7-23de-418f-a0c3-e12c8735d25b	2c075714bdce7df89f328062021733fd62880ff7cdb91a1d0a7aab2659a89d06	2026-01-04 12:32:01.731338+00	20240118235424_add_index_to_models	\N	\N	2026-01-04 12:32:01.729258+00	1
3f03b50c-e5a1-4692-8069-70771f09256a	af31e8b4be701e97ccf87d4692055d2cc7ece9d74cc424e05dfb2775de5a7efe	2026-01-04 12:32:01.744293+00	20240131184148_add_finetuned_and_vertex_models	\N	\N	2026-01-04 12:32:01.743471+00	1
fd3d5197-0286-4aae-98c2-cd00528eb5c7	c76d5a31377660ce77e890a918ffa07bd2db8c8c94b04753befbc27d152492ea	2026-01-04 12:32:01.732513+00	20240119140941_add_tokenizer_id	\N	\N	2026-01-04 12:32:01.731773+00	1
7e354805-8462-4dbb-85b3-866fb20ca17d	08f7d11bd5deec873669ca10101dd0a05669bb04eb300ef0ee7b6d3517ae0c24	2026-01-04 12:32:01.733553+00	20240119164147_make_model_params_nullable	\N	\N	2026-01-04 12:32:01.732756+00	1
3fcf1dc4-e3cb-4646-a090-a647f53dc6ad	540712b04f0fbaf449eaf229210e04dec83280878842c7c3d9956e4ff98334ce	2026-01-04 12:32:01.757448+00	20240219162415_add_prompt_config	\N	\N	2026-01-04 12:32:01.756702+00	1
5431506e-c4ab-47c6-af8f-f365e7bf8af0	3b0d3c46459cc2770d6e8d9db6fc139f859792da5b89937114dd09b17dac0dd4	2026-01-04 12:32:01.735257+00	20240119164148_add_models	\N	\N	2026-01-04 12:32:01.733977+00	1
12bff3d1-a62c-48c7-8a23-0f9c6308fbe1	3bc4965e82cd4645da383ef6f6582a7efd7f5bf27e912af1efe18ff62e014db1	2026-01-04 12:32:01.745276+00	20240203184148_update_pricing	\N	\N	2026-01-04 12:32:01.744569+00	1
eb2abc78-6aad-4685-b257-20e8e18caa0f	73f7212daa54130c6fa91fc17d840262ec948b11aafce49ea3e8ce7d4f3cbef1	2026-01-04 12:32:01.73861+00	20240124140443_session_composite_key	\N	\N	2026-01-04 12:32:01.735521+00	1
ea7097d7-94eb-4f77-86eb-98e4022ec380	4ec1ad8229c185a7afaa62357879a60d4f59b35a103975030ce43d67823096c9	2026-01-04 12:32:01.739675+00	20240124164148_correct_models	\N	\N	2026-01-04 12:32:01.738885+00	1
54814456-d70f-4895-ba87-83ef05c9cca3	546c704d2869f4d382fb591fd20b14c489e99fffaa5655c45a3a86e7a7d488c5	2026-01-04 12:32:01.740656+00	20240126184148_new_models copy	\N	\N	2026-01-04 12:32:01.739916+00	1
4c2386aa-ba6a-4a83-9eac-ff7a721e0204	3e0cc893b4ec41ef43740af577aef359e2c742c338c8fc5421f766d75cce1292	2026-01-04 12:32:01.749556+00	20240212175433_add_audit_log_table	\N	\N	2026-01-04 12:32:01.745815+00	1
0b41e0ce-2282-42fa-b53a-ca991ab0ec2b	f2af6a57ddd2aab8adeaa5a3c6571cd8ab8538b071fb01e07c35d277203ae6b8	2026-01-04 12:32:01.768522+00	20240226202041_add_observations_trace_id_project_id_type_start_time_idx	\N	\N	2026-01-04 12:32:01.766795+00	1
b39f179f-b91f-4990-affd-001f04d9cbbc	4a1b6917569327219e620f0cca78446c360958d5a91226b7f60bd4626ffb38d0	2026-01-04 12:32:01.750449+00	20240213124148_update_openai_pricing	\N	\N	2026-01-04 12:32:01.749806+00	1
ce3606d9-b80f-4b95-8e9a-0324088b614e	909cae9daaf399b3ab6e9c03142fa4b80d7b09f44165944b9a09007d829d6f28	2026-01-04 12:32:01.759138+00	20240226165118_add_observations_index	\N	\N	2026-01-04 12:32:01.757698+00	1
e6857b56-2592-4940-b48c-8f5236b481d5	a942356a983650fb3aa2974690956869324993c3a546ea83d3ae26d2a98db7c1	2026-01-04 12:32:01.753174+00	20240214232619_prompts_add_indicies	\N	\N	2026-01-04 12:32:01.750671+00	1
73b06e61-2afa-4fef-85ee-90385710d843	00a42d4d8bd4090cf94d90eeb82fe803d23d802dcdb6c058b2371a75d951519a	2026-01-04 12:32:01.754115+00	20240215224148_update_openai_pricing	\N	\N	2026-01-04 12:32:01.753449+00	1
6a1a4f3c-acec-4030-898d-01d8c54d7256	d498837088f8de279f4c04655af668c34f3febd961c95390a0441cb0ee0a3db6	2026-01-04 12:32:01.774835+00	20240228103642_observations_view_cte	\N	\N	2026-01-04 12:32:01.772882+00	1
1a2ddfca-8292-4074-a7c7-e00feadf36b8	58e1bb0a84cb20a36c750b9d13c1371e44cd1a4947d5bdb37754a23d664c5e33	2026-01-04 12:32:01.761129+00	20240226182815_add_model_index	\N	\N	2026-01-04 12:32:01.759392+00	1
33684a7d-8e4c-4ab3-9caa-b39acb6951b0	e31ee1ec510ded08a1813273056149bfe345651ce02d9ab31883dde10e390afe	2026-01-04 12:32:01.770474+00	20240226203642_rewrite_observations_view	\N	\N	2026-01-04 12:32:01.768769+00	1
f8b61a64-c0a1-414f-bcd0-414941b82f60	2cb0786da90de9c0a6e2983075362c76163e0635f9d347da0686b9c0434b8f0f	2026-01-04 12:32:01.764535+00	20240226183642_add_observations_index	\N	\N	2026-01-04 12:32:01.76163+00	1
817546c7-e759-43cd-b86d-202c07f47a34	e733981599148cbb086a4eb4e7276fac2059ce3b60b3acf1443c3ec648f1d233	2026-01-04 12:32:01.766561+00	20240226202040_add_observations_trace_id_project_id_start_time_idx	\N	\N	2026-01-04 12:32:01.764793+00	1
866d070c-b608-44de-980c-6f46b0948a90	5603e17abf74b6c9e4191ff261e56e63641a90c5e04d99c5f04be174d1a90d76	2026-01-04 12:32:01.772626+00	20240227112101_index_prompt_id_in_observations	\N	\N	2026-01-04 12:32:01.771008+00	1
980ea76b-29c5-4d08-ad51-00ad4342e280	83902ab9281b0b9b7257768518cbfb6895d382f30e6594b2058507d173bfa519	2026-01-04 12:32:01.778459+00	20240304123642_traces_view	\N	\N	2026-01-04 12:32:01.776974+00	1
253a0fe6-8544-4f6a-9323-4b5398b5eab3	96e0223ba9bb5ec06dc4c53988451298d6cf9df6b83da89262280ceb3c203d59	2026-01-04 12:32:01.776727+00	20240228123642_observations_view_fix	\N	\N	2026-01-04 12:32:01.775092+00	1
15eb2e2e-c360-4b03-a9df-bf3ab1faa15e	b9abacb6b7858085eff8230a9950eaffe2e557c67981592097a2b93204b3c5ec	2026-01-04 12:32:01.782339+00	20240304222519_scores_add_index	\N	\N	2026-01-04 12:32:01.780799+00	1
19346c7f-33cc-4af2-8b21-5d1c8bd93048	f8e14cfb18416f04c49e67c2e9c97675b1d01a1a60a549d784cfbcd52f308771	2026-01-04 12:32:01.784156+00	20240305095119_add_observations_index	\N	\N	2026-01-04 12:32:01.78262+00	1
d003a459-4191-41f0-870b-59cba2f4dd65	498c50087ca98fffe98b041b77c8ef195888e35e607b3c0d64643d9275e83935	2026-01-04 12:32:01.786353+00	20240305100713_traces_add_index	\N	\N	2026-01-04 12:32:01.784402+00	1
500e780c-4e07-4aa3-9c53-b8ac7f09e5de	89a9d0e9dd25662dd684333947df23ea4165a4adec9995e281b33fecdd60b775	2026-01-04 12:32:01.787928+00	20240307090110_claude_model_three	\N	\N	2026-01-04 12:32:01.786861+00	1
c696798c-2d30-492f-9746-d10772b598a7	7a8d3f1cb3ce402ca6de3b8af2f9f402770d7bb1b9a0ba740dd691b5e88feb1f	2026-01-04 12:32:01.78904+00	20240307185543_score_add_source_nullable	\N	\N	2026-01-04 12:32:01.788188+00	1
184b4b23-4bb3-4c81-afac-82f4ef4e7543	cbf36bf3115f7c66934d46e7d8f4a21c7465f9d00569d619b7382028ee422eb3	2026-01-04 12:32:01.807462+00	20240404210315_dataset_add_descriptions	\N	\N	2026-01-04 12:32:01.806565+00	1
23644b80-99dd-4f99-ae5d-ec6726bfa743	b9c551f91d345926b3c740563aecff3904717185b84dcdf74c0b2521ffa2cb63	2026-01-04 12:32:01.792505+00	20240307185544_score_add_name_index	\N	\N	2026-01-04 12:32:01.789323+00	1
4cb1fb8c-5318-4907-aecb-61e36be68b02	0cec970448bd9ff3a78acdcce5519f9c2154378ccc3a3acbd79266478f66238e	2026-01-04 12:32:01.79358+00	20240307185725_backfill_score_source	\N	\N	2026-01-04 12:32:01.792763+00	1
d6f003e9-dfb9-4774-bb90-f41957ec5067	c8ea9587bcf109835eb4b8cb882e121c35624d5e9f90e21886de3b7ee5793312	2026-01-04 12:32:01.854623+00	20240424150909_add_job_execution_index	\N	\N	2026-01-04 12:32:01.853093+00	1
f77a473c-3591-4461-98e5-9cfba8a36ce6	1a476db15f8f2a6becbde3c804623832542a9d2dc1233389e9b4d1c9047a5b43	2026-01-04 12:32:01.794825+00	20240312195727_score_source_drop_default	\N	\N	2026-01-04 12:32:01.794123+00	1
486c1eb6-08ec-4abf-90d1-cdce9bf70148	b5d68c44ed85196b038921cde3faf6241050b76781a9d93981346165436c6ed7	2026-01-04 12:32:01.808398+00	20240404232317_dataset_items_backfill_source_trace_id	\N	\N	2026-01-04 12:32:01.807731+00	1
19b9c127-ec45-4c38-bcc4-0fb4b725ff9d	137f83659a950bdc6497c2030f61bd070264ee14387f3e11143f55ae2c3d810e	2026-01-04 12:32:01.795756+00	20240314090110_claude_model	\N	\N	2026-01-04 12:32:01.795063+00	1
dce581c9-6e67-4d12-8bdf-3333c58b0ff8	9e7f1d6a2d8e12037a931e8d8c86e552366e8056d2a9adb847f84da5c6972398	2026-01-04 12:32:01.797324+00	20240325211959_remove_example_table	\N	\N	2026-01-04 12:32:01.795992+00	1
a3d5672b-2b0c-4660-83e2-15c0cadb4d4b	e0d84647251c69f99883c12c21eb9cbad9f0fc1059b58cce3296edeebdc1b8dc	2026-01-04 12:32:01.836184+00	20240414203636_ee_add_sso_configs	\N	\N	2026-01-04 12:32:01.832308+00	1
4120d866-4226-4d34-9854-338699504d57	48d049e8d66ed3f4b0336d857ae4bfeb7f39dd9ee1070fbe4bede32630478e7b	2026-01-04 12:32:01.798247+00	20240325212245_dataset_runs_add_metadata	\N	\N	2026-01-04 12:32:01.79756+00	1
b64abc56-e3ca-4e69-be80-6ebaeb496f46	82c21f5f2399c1173c734d8a157b4b0dac6821cbbc36dce8ba058caf40681ff7	2026-01-04 12:32:01.810087+00	20240405124810_prompt_to_json	\N	\N	2026-01-04 12:32:01.808966+00	1
a928ee14-e198-4f07-b359-fdcc6a9448ec	3fa446eb946ec9e8f56c4665e02aea106727c4058acd89dd758900273a2183d8	2026-01-04 12:32:01.799932+00	20240326114211_dataset_run_item_bind_to_trace	\N	\N	2026-01-04 12:32:01.798791+00	1
6d5969f0-4f19-43dd-8c96-8d295d547d50	f6efc777385ff3f04b4c93745d7a66fe953a4fb4544203ad22808b80468f3578	2026-01-04 12:32:01.800985+00	20240326114337_dataset_run_item_backfill_trace_id	\N	\N	2026-01-04 12:32:01.800154+00	1
2d08676f-5da6-4829-a656-3798584edf3d	7c084b86913a91f9b8658084f6b8f6526bce2d0de4842c8f68e07f30f1f46fe9	2026-01-04 12:32:01.801933+00	20240326115136_dataset_run_item_traceid_non_null	\N	\N	2026-01-04 12:32:01.801279+00	1
0abc4707-970d-43aa-9889-566d6ed4e06f	206607c9c910399b23bb8217092e4b17fd428f2890efb49f1ad65dceaa55f3d1	2026-01-04 12:32:01.82563+00	20240408133037_add_objects_for_evals	\N	\N	2026-01-04 12:32:01.810385+00	1
43d55c09-b698-4e12-97e1-afe2fe8a712e	afe59690f207d0f4481d9a54af3e743622a88a68ad46d4eb2597c2b7a953fc66	2026-01-04 12:32:01.803719+00	20240326115424_dataset_run_item_index_trace	\N	\N	2026-01-04 12:32:01.802207+00	1
f222c46b-b9e0-404a-9491-5d5b9f7f7eb8	10e5a3983b46239bbb0b6ad8617901df3c7eaa53df0b879577528d7e14d84d91	2026-01-04 12:32:01.804896+00	20240328065738_dataset_item_input_nullable	\N	\N	2026-01-04 12:32:01.804217+00	1
dffc96ca-f9f9-4a03-bb99-836b7c58ae42	b01064942f09a3e944a7db83a680ba04e135b6aee91569445ba295a2ce443f74	2026-01-04 12:32:01.847224+00	20240420134232_posthog_integration_created_at	\N	\N	2026-01-04 12:32:01.846253+00	1
a09357a9-019c-44c9-bcda-69326a8ef251	04c22689adda42b47ce94563fc3e834507c8b214a20ae1d379b2cfa9ed4e6d73	2026-01-04 12:32:01.806292+00	20240404203640_dataset_item_source_trace_id	\N	\N	2026-01-04 12:32:01.805126+00	1
2610ac38-352f-4b62-bf89-68d0ea8a3710	dcd8dcb804ab5eeb3cc813b88ea510578a6b481e5756628b0fa7d061d9aa79a5	2026-01-04 12:32:01.838465+00	20240415235737_index_models_model_name	\N	\N	2026-01-04 12:32:01.836824+00	1
91202a1c-bf7d-4b5e-9fed-ec49eb371985	b9711c48f8a9d20c8705c31f1a2bd4a4e1e3473e7de6f884ced0776773dea897	2026-01-04 12:32:01.826701+00	20240408134328_prompt_table_add_tags	\N	\N	2026-01-04 12:32:01.825888+00	1
bd4df3a9-01fb-4678-9f04-01aba5fe2dfb	017eaef133c6ad53c86e655daf6ef310f5e8870d197b32b91b22feea8589c20d	2026-01-04 12:32:01.828284+00	20240408134330_prompt_table_add_index_to_tags	\N	\N	2026-01-04 12:32:01.826955+00	1
3a8c5702-301e-43c8-89fb-53ce39c42045	5b74cc3719cc73c4a9561521df9593a0b72b7f71a7edc6fc962259855d1b4597	2026-01-04 12:32:01.829644+00	20240411134330_model_updates	\N	\N	2026-01-04 12:32:01.828885+00	1
88bd03ae-4af0-47bf-bfff-3317fcfa684e	20f9110c61428813f2d32bff079f64fe35ee3dbb6eb40241c24885ca87e44226	2026-01-04 12:32:01.840076+00	20240416173813_add_internal_model_index	\N	\N	2026-01-04 12:32:01.83871+00	1
f008d667-3d8c-49ec-95bc-0df3f3f3b9ee	86412f0fd3a38ecf7aba62d2df6bc63f21d8545c6846e7ad450f1ba1054ec0ef	2026-01-04 12:32:01.83103+00	20240411194142_update_job_config_status	\N	\N	2026-01-04 12:32:01.829919+00	1
5dca7bc8-e29c-4760-a7e0-f8d3ea75ab95	0f44dce07307ae9364e93449837fe6fc6189780dd94b7d506f8c2f653423b42a	2026-01-04 12:32:01.832056+00	20240411224142_update_models	\N	\N	2026-01-04 12:32:01.831388+00	1
f113a528-7bd0-439d-9381-e94f643bf65a	e79db3e95ce362750535a772337f79cd94bc37890e58ce3c05aa0253afe1d1d6	2026-01-04 12:32:01.841303+00	20240417102742_metadata_on_dataset_and_dataset_item	\N	\N	2026-01-04 12:32:01.840361+00	1
b03251a3-2b79-4f07-aed5-9d35152c40d4	b5153e69a337304509d94116fc42eac4ae838617041d473e361627e99d78eaeb	2026-01-04 12:32:01.848357+00	20240423174013_update_models	\N	\N	2026-01-04 12:32:01.847548+00	1
f4b2db2b-3961-40c6-b6cf-6b80b2cb5208	d53f2ddcfda91be76c40f87c0ebdeee510cf7316e6ce8578e16a3a068daf0bd5	2026-01-04 12:32:01.845743+00	20240419152924_posthog_integration_settings	\N	\N	2026-01-04 12:32:01.841552+00	1
d5f6f127-1b9a-4ee9-9e83-dee077dd118f	a15e5ed199ff9e77ad2ab1920262094a07c63c5bf639929e7912e3ec5b6f1da0	2026-01-04 12:32:01.859858+00	20240503130335_traces_index_created_at	\N	\N	2026-01-04 12:32:01.858563+00	1
24875989-ac6b-4dc6-9eec-e0ba55fa7378	0a6f2078af2b92a1d61d36449f3646fb8adda99acb6ee214451b8c2a7a62c36c	2026-01-04 12:32:01.852866+00	20240423192655_add_llm_api_keys	\N	\N	2026-01-04 12:32:01.848591+00	1
5b262953-193b-48ee-98e3-c4034e638e4b	6c5083ecdb222c9a4566fac6a4364a349351e868bb68eff17a7c8c48bacf39c1	2026-01-04 12:32:01.858331+00	20240503125742_traces_add_createdat_updatedat	\N	\N	2026-01-04 12:32:01.857192+00	1
c8e4833e-16d4-4e50-8db1-d5a94e81a531	a2ff78bbd0982e80edcc312bb686a9d33f4bde7e675d0915ba570aff2931307d	2026-01-04 12:32:01.856027+00	20240429124411_add_prompt_version_labels	\N	\N	2026-01-04 12:32:01.855155+00	1
b46a8f53-bc95-43d8-9820-43919a370376	caf1f29f946abe2c7774657473a274866a1bab1a4d4b368bac32154c263aba22	2026-01-04 12:32:01.85698+00	20240429194411_add_latest_prompt_tag	\N	\N	2026-01-04 12:32:01.856239+00	1
469aabb0-1453-492e-b875-da8ae961eba9	6d3ba16762dc0033c95dabd79ef2ac122e8416c7ec5cd15ef761057837b19c92	2026-01-04 12:32:01.861728+00	20240503130520_traces_index_updated_at	\N	\N	2026-01-04 12:32:01.860323+00	1
552051e2-913e-4b93-8ed8-3f50769c8747	86eaf205ba5fd2130957536777d0aa00c8d15cdc2af896ea5b45ed5f26d690b6	2026-01-04 12:32:01.862518+00	20240508132621_scores_add_project_id	\N	\N	2026-01-04 12:32:01.861941+00	1
57e33962-4c14-4d17-8e4d-b23aa0ef5f9d	644c6246091a13e8e908733347ffd699789d448bb3c80207e53b32223667a292	2026-01-04 12:32:01.864298+00	20240508132735_scores_add_projectid_index	\N	\N	2026-01-04 12:32:01.862738+00	1
5751547a-54d5-4713-b200-a3a3c38a7b12	c1e8301b3c0ad83f46731fa6398565faa586ee89b5dc4ff22a2289a9f7c21d8e	2026-01-04 12:32:01.865314+00	20240508132736_scores_backfill_project_id	\N	\N	2026-01-04 12:32:01.864538+00	1
9ba42b54-e045-4e09-870b-a616a2db6cec	3425cdbd747937bbb512b560a2b8132462d0412191a695e27dc9ae268f3d40f2	2026-01-04 12:32:01.866779+00	20240512151529_rename_memberships_to_project_memberships	\N	\N	2026-01-04 12:32:01.865814+00	1
221d1900-b4e9-4030-a85e-61df44f8d237	8030bef72fbca691d64e1fe5ca79e3f51e6137d85d73ec9afb97860ce81969dc	2026-01-04 12:32:01.939084+00	20240528214728_add_cursor_index_08	\N	\N	2026-01-04 12:32:01.937387+00	1
67428b14-04cb-46de-9601-70158c569bab	d010f310671b164935b005b7949c29a46a2f14117e14060702f239cf3bb081cb	2026-01-04 12:32:01.879391+00	20240512155020_rename_enum_membership_role_to_project_role	\N	\N	2026-01-04 12:32:01.867016+00	1
6f6185ad-91d1-489c-9f39-5cbb47faebd3	326dfa3b9b80dc55e40ab489fb74671a5c16a4aba84c9696b270880c7bfe46f6	2026-01-04 12:32:01.903961+00	20240524154058_scores_source_enum_add_annotation	\N	\N	2026-01-04 12:32:01.903266+00	1
379c5aff-6361-4b5b-a5fd-de28b64de435	a398b1ccdba2791a4646955f37522df929dd0e0a2d01603a068f70e096d2f53a	2026-01-04 12:32:01.881471+00	20240512155021_add_pricing_gpt4o	\N	\N	2026-01-04 12:32:01.879638+00	1
450f6676-ade5-47a9-a4c4-e5e1b665b6b4	f9750ea80adc2a175c4455a32779c5a607d741b71ca8354a18d9e8273b70b9a0	2026-01-04 12:32:01.88303+00	20240512155021_scores_drop_fk_on_traces_and_observations	\N	\N	2026-01-04 12:32:01.881901+00	1
6c5ec862-3431-4072-a10f-9d812333cc9f	dd6ec73dbd2dad9918cacba3f3b36aa35e88eb88a533ba89a9e0589eab28919d	2026-01-04 12:32:01.923904+00	20240528214727_add_cursor_new_columns_scores	\N	\N	2026-01-04 12:32:01.922933+00	1
9fdf70ca-152a-4b76-b242-30d48d45ef4c	18525089d536b836d81e02dab68588e4fe2bf3d0a09e4c349d60db9bbed0cd49	2026-01-04 12:32:01.88454+00	20240512155022_scores_non_null_and_add_fk_project_id	\N	\N	2026-01-04 12:32:01.883562+00	1
e6a4f98d-d940-48f6-8759-ce77e47e6b37	7c2d55160da3c5b58bd2710b99a9af01a92fccde03c15703fe59ab2d2c2965a0	2026-01-04 12:32:01.904855+00	20240524156058_scores_source_backfill_annotation_for_review	\N	\N	2026-01-04 12:32:01.904198+00	1
4820d543-8578-47f7-a2d3-28260f23b821	6f038363d06b8fe9ad5e5ffdebec33d4cde3591c65fe46175a4a821736637482	2026-01-04 12:32:01.885443+00	20240513082203_scores_unique_id_and_projectid_instead_of_id_and_traceid	\N	\N	2026-01-04 12:32:01.884763+00	1
701430c7-2baf-4ced-9cf3-b08317c10c34	e39e28c4337fa35ab175c703d6ceda8a2d4b78d2bc616200201faff350c61455	2026-01-04 12:32:01.887443+00	20240513082204_scores_unique_id_and_projectid_instead_of_id_and_traceid_index	\N	\N	2026-01-04 12:32:01.885676+00	1
736ff8a6-f4ca-45e0-bc80-abb63babc47a	b8c134bdcba9a016d8ac79927a0d736c67c5bbf109ec584a15b0f6c38f50dc8d	2026-01-04 12:32:01.889311+00	20240513082205_observations_view_add_time_to_first_token	\N	\N	2026-01-04 12:32:01.887707+00	1
49bfa5ec-f1db-47aa-a9cc-548c46df820e	fff8108a9e3a443689ffc664fcb57f386343171b43607da12cc3ea46d7700585	2026-01-04 12:32:01.913675+00	20240524165931_scores_source_enum_drop_review	\N	\N	2026-01-04 12:32:01.905103+00	1
d39e024f-4b60-4b43-adb8-32856be41fdc	69b89171901be90854380c467ab615e82864cf72c128a011c0679b6e5af51e96	2026-01-04 12:32:01.890602+00	20240522081254_scores_add_author_user_id	\N	\N	2026-01-04 12:32:01.889685+00	1
1a3cd35d-b4ec-4a26-b78a-9af462a3b4cf	1cba5ea95d8968dd4a1dfb6df8e844accbffca9d15e88aa87416eb6115b650e4	2026-01-04 12:32:01.892177+00	20240522095738_scores_add_author_user_id_index	\N	\N	2026-01-04 12:32:01.890813+00	1
aef77588-fa8b-48cb-9ac6-efad330444f1	75ba9583fb449a727d79158ed02d694b490c2d300c2da3eac7c79439966859d5	2026-01-04 12:32:01.933792+00	20240528214728_add_cursor_index_05	\N	\N	2026-01-04 12:32:01.932542+00	1
0d8012b9-ee4e-444c-a398-bda4fd9f9424	439692a5f62df8e88a5aa6216e2019092d04f48a22f063861e20da6e3a278a9b	2026-01-04 12:32:01.898471+00	20240523142425_score_config_add_table	\N	\N	2026-01-04 12:32:01.892403+00	1
c4d9b02a-e493-4ab0-a457-7391a7400040	d186efeb838e34c83c0174fe727768a3b23487734d222ed8393b8cc0be4e83a3	2026-01-04 12:32:01.915644+00	20240524190433_job_executions_add_fk_index_config_id	\N	\N	2026-01-04 12:32:01.914032+00	1
96d39d93-ae01-4558-971a-1ab8156b0560	b6930ec8ce14d8a5e0d6792049f3af79bbd1ba1e4990ad2535ebc859edf856d9	2026-01-04 12:32:01.900174+00	20240523142524_scores_add_config_id_idx	\N	\N	2026-01-04 12:32:01.89869+00	1
e3f7cfae-8281-41f3-9289-5e2b92ebb9f1	3df7e7fc9c22f17c9e8bdfd663cc2e5c473ec3e6e97129eebb989007943376d5	2026-01-04 12:32:01.903039+00	20240523142610_scores_add_fk_scores_config_id	\N	\N	2026-01-04 12:32:01.901257+00	1
a1a6d6bd-59c1-4bc0-9727-90d91af89e44	952e15d6cf5306bb4802cc82fbe9f957196d77cc7f9035908014b205c5245232	2026-01-04 12:32:01.92567+00	20240528214728_add_cursor_index_01	\N	\N	2026-01-04 12:32:01.924118+00	1
2dcdea86-46a1-4d4a-9f32-923348e83107	ea772561308b485138a96c9fde5666910bc8cfebc30763463acbade405198412	2026-01-04 12:32:01.918301+00	20240524190434_job_executions_add_fk_index_score_id	\N	\N	2026-01-04 12:32:01.915848+00	1
07b82400-2516-4ee8-b55a-c39b55b3d408	200a30bd560504185fd90be17c50db344bd1a71ecd599eefa5dc5d1b8504d0b5	2026-01-04 12:32:01.919965+00	20240524190435_job_executions_add_fk_index_trace_id	\N	\N	2026-01-04 12:32:01.918518+00	1
4c1aa288-1a30-444c-98b1-c67a591a2d05	28f7b81fda65228917bc40cbd676aa362538a3e32c328d7ee8069e6195f5319b	2026-01-04 12:32:01.921664+00	20240524190436_job_executions_index_created_at	\N	\N	2026-01-04 12:32:01.920191+00	1
6091681f-9476-478f-bbe0-f23aa24a4357	78b6379bbc520233c72ece8af40ed3e44c185479a4d65da104e3005394add5b7	2026-01-04 12:32:01.927357+00	20240528214728_add_cursor_index_02	\N	\N	2026-01-04 12:32:01.925884+00	1
54881c8c-3f42-440d-a74b-64f48e6e6b6d	41f0f23e453c12cda5517c9f4da23112d7385ad3892f21114d2fcdd20ce1648c	2026-01-04 12:32:01.922725+00	20240528214726_add_cursor_new_columns_observations	\N	\N	2026-01-04 12:32:01.922033+00	1
69784e41-0f68-42ad-bcd8-a4cbfddb3d07	193aa18cb545aaa488d5d5c4852d61cd136eea2af6c4ffc9359dcf00cdda60c8	2026-01-04 12:32:01.93076+00	20240528214728_add_cursor_index_03	\N	\N	2026-01-04 12:32:01.928623+00	1
7a39c765-a951-4524-86fd-c70b11155fdc	60796f59b086bb8e2c4f4901464cf99afc9baddbd4b9f67b492f93a0d192dac6	2026-01-04 12:32:01.935597+00	20240528214728_add_cursor_index_06	\N	\N	2026-01-04 12:32:01.933996+00	1
a77ae743-df8c-4863-a1ad-c5f84ee17dd5	dca517a57077ee57fdbad8c599951dd6e12efbe9608579f211c750d46282ddd8	2026-01-04 12:32:01.932309+00	20240528214728_add_cursor_index_04	\N	\N	2026-01-04 12:32:01.93098+00	1
bcde12f1-c5a6-4497-ac70-72a4cbb5c9d4	43fabe3d60f20b7af6fa380afa5d3caee722ba94b2affffec300f06ae402870a	2026-01-04 12:32:01.950641+00	20240528214728_add_cursor_index_12	\N	\N	2026-01-04 12:32:01.945755+00	1
f1a84728-d622-447f-9018-0d11b6957992	cd23d112029122106a7bae095c44e7d5ea702d5b5839898dde76855126b70e8d	2026-01-04 12:32:01.937181+00	20240528214728_add_cursor_index_07	\N	\N	2026-01-04 12:32:01.93595+00	1
69505d72-9b3c-4e31-b7c7-731166bb527a	ccc9e57838b1cb6a14d7ea38f87a363e256a9ebe54c7799f972880a05951679d	2026-01-04 12:32:01.945493+00	20240528214728_add_cursor_index_11	\N	\N	2026-01-04 12:32:01.942509+00	1
6f1c9ac8-d720-4a6a-bf5e-681da72a7762	1e687237d6e6b1dbbc0627d78a9eacf6a25a7d9232db4841b7c1be90cfebadd2	2026-01-04 12:32:01.940605+00	20240528214728_add_cursor_index_09	\N	\N	2026-01-04 12:32:01.939331+00	1
c198cf0e-4471-44ed-9fd2-a6d631349337	422f4d18f07108fd2a6a4bcae46f66a8afd1374c46f0b29efce0aab376e199a7	2026-01-04 12:32:01.942152+00	20240528214728_add_cursor_index_10	\N	\N	2026-01-04 12:32:01.940828+00	1
33a5e346-3224-4849-bcff-64c97af61a8e	c94c666ca537a5dd8e8c1f8353c337990be02587535bcd31d793714391a35340	2026-01-04 12:32:01.95238+00	20240528214728_add_cursor_index_13	\N	\N	2026-01-04 12:32:01.950889+00	1
cafe0c89-3e3f-4f47-ab59-ccec48e22ff1	372bd565f444f56abba3316b7642994ee2dab8d07a8e918366e235d8282573ed	2026-01-04 12:32:01.954138+00	20240528214728_add_cursor_index_14	\N	\N	2026-01-04 12:32:01.952605+00	1
2055ae50-4336-4923-b816-794bb22fde7b	e64d2f82e0e18bdeb80a75f75a19839cd5e0579e0c13336369191fe582592c98	2026-01-04 12:32:01.956128+00	20240528214728_add_cursor_index_15	\N	\N	2026-01-04 12:32:01.954534+00	1
b7210e4d-5a3c-4560-a621-67b8501ab408	0a4105318c8c643b080415ad0d5566252acdefcbf7d95e10d93c0c7837f23202	2026-01-04 12:32:01.957956+00	20240528214728_add_cursor_index_16	\N	\N	2026-01-04 12:32:01.956376+00	1
bad5b8b0-a9c3-47bf-87fd-f6e779b26e5c	c990b7a6ca81f32c14b6faa15ce64f673fb4ea950ee29295c0216aeb73505dac	2026-01-04 12:32:01.960066+00	20240528214728_add_cursor_index_17	\N	\N	2026-01-04 12:32:01.958204+00	1
c9a4938e-fe36-470b-92ec-8e8f2659b41e	d3234c35c64e4ab9465ef5d699f2448147093e8d824e9287da35ae03b68276f5	2026-01-04 12:32:02.005818+00	20240710114043_score_configs_drop_empty_categories_array_for_numeric_scores	\N	\N	2026-01-04 12:32:02.005189+00	1
b7eb0be5-2a6e-4722-94f8-cf2411b31a1f	91bd416591a20ebf4a43e477e96840b27d9d719f228356836debf7aaf5a63c76	2026-01-04 12:32:01.961617+00	20240528214728_add_cursor_index_18	\N	\N	2026-01-04 12:32:01.960309+00	1
1c6f08bc-d194-4bea-9a7d-4bc8e09e7e26	08a92b24efa2f28043e5050f1071c39be9927e759fea2d68ed1a026f85457d25	2026-01-04 12:32:01.983329+00	20240618134129_add_batch_exports_table	\N	\N	2026-01-04 12:32:01.978011+00	1
6d04dcd7-1936-40a7-a14b-689bb855fd2b	c4155024314491d05b341db42b38ad22d35084502c842c3003f7e3a9a8278603	2026-01-04 12:32:01.963194+00	20240603212024_dataset_items_add_index_source_trace_id	\N	\N	2026-01-04 12:32:01.961971+00	1
4e7ebbbc-e291-4541-bcd2-a9056b9747af	c683e1a9bd10c23b0c47a8b24a4abf88a7c6c090f49288f1866308662811ca56	2026-01-04 12:32:01.965401+00	20240604133338_scores_add_index_name	\N	\N	2026-01-04 12:32:01.963439+00	1
9010776f-b721-4a71-b7f0-2e2f64fe350a	f0a4088b40007ed6f163f39d19c1656d29185f5002d32c902f73e872c3db953d	2026-01-04 12:32:01.993455+00	20240624133412_models_add_anthropic_3_5_sonnet	\N	\N	2026-01-04 12:32:01.992864+00	1
eb17a754-9975-4147-b521-cfc5314b4f39	a83f3d6ccaf505beb1d4e1e389e75f1e2f908e7f38083cdd0e9fe890b1a32ac5	2026-01-04 12:32:01.966323+00	20240604133339_score_data_type_add_boolean	\N	\N	2026-01-04 12:32:01.965678+00	1
be6c6986-d81a-4094-b1f4-6b7096e194e3	3dc892b57cc62544e92fd075401e0ddb9edd5536a014a1b0abcd8554c8c08f44	2026-01-04 12:32:01.984519+00	20240618164950_drop_observations_parent_observation_id_idx	\N	\N	2026-01-04 12:32:01.983678+00	1
1c394dfb-f6eb-465e-9fbb-bb1ff11a0edf	4cfdd5861ab132ab402a50a8167c2f85b8dfcd59b9cf657c3a450822b428d421	2026-01-04 12:32:01.968007+00	20240606093356_drop_unused_pricings_table	\N	\N	2026-01-04 12:32:01.966554+00	1
6df09159-a55b-44e2-b7ce-2142d5e3a068	4dbdbcaf043e14669304021c929c5544297e4c1288814b373ac6180403a8e243	2026-01-04 12:32:01.969537+00	20240606133011_remove_trace_fkey_datasetrunitems	\N	\N	2026-01-04 12:32:01.968387+00	1
ca655d56-ce58-46aa-ad3d-8231791941e5	0e9d74c1cca79b04a49aea0a7590e985b40e87ab425919cf7625b5c9dbd08eae	2026-01-04 12:32:01.970476+00	20240607090858_pricings_add_latest_gemini_models	\N	\N	2026-01-04 12:32:01.969796+00	1
1bf1ae5f-59ff-4858-8d46-eb607ca89a64	2966ccefa13d04e5bbe2fd2e6d199c46ea2915b4158b75b02840a072cbfc506d	2026-01-04 12:32:01.985729+00	20240618164951_drop_observations_updated_at_idx	\N	\N	2026-01-04 12:32:01.984725+00	1
9fe5dae9-3dfb-488e-8196-fd06994e8156	844d238a2a7adc1bea26071ec926f5deae3bfad1a132498b539a8a73f7cd9b84	2026-01-04 12:32:01.971396+00	20240607212419_model_price_anthropic_via_google_vertex	\N	\N	2026-01-04 12:32:01.970738+00	1
65c7d3ce-3d38-4fdc-b1a0-8c5eaa5ba426	bfb32da23d69cdd9b16e9b7a9397c199656f43a088d611bb870160be7162e456	2026-01-04 12:32:01.973127+00	20240611105521_llm_api_keys_custom_endpoints	\N	\N	2026-01-04 12:32:01.971623+00	1
cf9bbbd4-f65b-42f2-9c47-75b5fda720b9	83c99f9d7f01ce1809e973fc571f11ce8f9a29c721832406b1632dc1340ce31a	2026-01-04 12:32:02.000248+00	20240704103901_scores_make_value_optional	\N	\N	2026-01-04 12:32:01.999103+00	1
fb1568b3-8d09-4469-a30f-847e98cc88c5	e7110b354d5834e771980c2486a334501fc6c00d60d7489a771e6e32cdf113cf	2026-01-04 12:32:01.974765+00	20240611113517_backfill_manual_score_configs	\N	\N	2026-01-04 12:32:01.973482+00	1
7aa7bcb9-9c6b-473b-9e35-4836f249e3a3	cd37d3269447a71e8de058e7391986faf4d1ea88c7fc06e9e9de6d4d6754b7e8	2026-01-04 12:32:01.987076+00	20240618164952_drop_scores_updated_at_idx	\N	\N	2026-01-04 12:32:01.986081+00	1
6704745b-6ae3-4f5c-906c-f77fa9131f23	5ffd2fdb41ff144cb14035a9feac869134180508f9ccf5c55f3d04a7c574f560	2026-01-04 12:32:01.976512+00	20240612101858_add_index_observations_project_id_prompt_id	\N	\N	2026-01-04 12:32:01.975015+00	1
8df54075-c6eb-4b3e-ab8e-aad0ed689aac	0c2ce80ed19bda8480a47a63222e518a74233937dd620d6856c85986e56459b5	2026-01-04 12:32:01.977736+00	20240617094803_observations_remove_prompt_fk_constraint	\N	\N	2026-01-04 12:32:01.976778+00	1
fbc284d5-864e-49c2-b119-09d94312c58d	9d90da7cedae6dec276adee4484197e2a07a7007c17ccb309dfe1c228f0afb15	2026-01-04 12:32:01.994425+00	20240625103957_observations_add_calculated_cost_columns	\N	\N	2026-01-04 12:32:01.993674+00	1
44c695c3-c58c-445d-9cdb-6bf8a63777c3	0f6b92ccc813c06eb9263e103d06c49bb31e5681c1eee935ce78b2302129e590	2026-01-04 12:32:01.988249+00	20240618164953_drop_traces_external_id_idx	\N	\N	2026-01-04 12:32:01.987332+00	1
39224208-966c-4b03-99bb-3711955e597d	e8d748c34b7129a45445356f094c587d6d8abcf6e6b545fdb86c7343503db2a1	2026-01-04 12:32:01.989468+00	20240618164954_drop_traces_release_idx	\N	\N	2026-01-04 12:32:01.988637+00	1
95893698-686d-4eab-b9e2-a21aba5f8885	189b316f8030f65f38d576d67418f1171c12e642b05d6368cd07b44253fdc7a6	2026-01-04 12:32:01.990573+00	20240618164955_drop_traces_updated_at_idx	\N	\N	2026-01-04 12:32:01.989682+00	1
3d5b4c26-c747-4a67-8434-aac2d068da27	bd764616a4a133fcc775e140ec8b55f4cbbb553c69ab8d7f7f7095d0a32b2bc6	2026-01-04 12:32:01.995208+00	20240625103958_fix_model_match_gpt4_vision	\N	\N	2026-01-04 12:32:01.994641+00	1
8b3f2e5f-baee-479b-b546-5e6ed7b01d59	54fce5d78c8c90abf77f97d3b1411ef0fa9346b08c113f6aa7127b4cba72bf13	2026-01-04 12:32:01.992526+00	20240618164956_create_traces_project_id_timestamp_idx	\N	\N	2026-01-04 12:32:01.990954+00	1
86a50114-4742-490c-859e-c65bde6067c9	1fcd4df49e013083ab4d3a0431ec979098eee48f568286401cde8fa4e3e3f5f8	2026-01-04 12:32:01.996118+00	20240703214747_models_anthropic_aws_bedrock	\N	\N	2026-01-04 12:32:01.995464+00	1
b2b9a546-3460-4c1b-885b-e895a2c505bb	09738b0d810db898fc0cef843f3ee6a2329a01dc47d03c7120013c70c37b1e33	2026-01-04 12:32:02.002686+00	20240705152639_traces_view_add_created_at_updated_at	\N	\N	2026-01-04 12:32:02.000607+00	1
ee429505-bac9-4333-b8b8-222aae884f81	bfe9303dbead984f51c5a743ca1106d5763600146ff1ed32de29676474887ef5	2026-01-04 12:32:01.99877+00	20240704103900_observations_view_read_from_calculated	\N	\N	2026-01-04 12:32:01.996458+00	1
d5addcff-93e9-450e-a903-75d96cf7d525	9ba7731449b181af27b35098e2737877179ecb607c5ee1cdff8ba70c4e973036	2026-01-04 12:32:02.015286+00	20240718004923_datasets_tables_add_projectid_composite_key	\N	\N	2026-01-04 12:32:02.007219+00	1
71fb1d23-54c8-46c8-9c7f-f8c0f009c53c	b4c944a0fccea1e77f5b3026b958dfcf421d7c53794ef63289aa0ac3503b5f0b	2026-01-04 12:32:02.004949+00	20240705154048_observation_view_add_created_at_updated_at	\N	\N	2026-01-04 12:32:02.002996+00	1
4f0bda88-e56e-4760-97a5-8417070903ec	ac968e7f259110955d27da88e05de49668356907f0832f7fe609738d515712f5	2026-01-04 12:32:02.006947+00	20240710114044_add_pricing_gpt4o_mini	\N	\N	2026-01-04 12:32:02.006076+00	1
e740ee9e-ef82-40d0-a612-1318ed91f486	d0e5e3951923f398d25390a608624b8c7bb45349bd421441a0f502e406b04507	2026-01-04 12:32:02.018084+00	20240718011734_dataset_runs_drop_unique_dataset_id_name	\N	\N	2026-01-04 12:32:02.017202+00	1
190e89cd-c2fd-47bd-9dd8-23a0b6b264be	d4d71b3fd3254ac5a43f13e1ddffab6f77402911e682a8ee7d97f3db68c1c6d9	2026-01-04 12:32:02.016982+00	20240718011733_dataset_runs_add_unique_dataset_id_project_id_name copy	\N	\N	2026-01-04 12:32:02.015542+00	1
62c126b1-a2fd-4ffa-84c3-ef4d74c82d01	e30dba696d156c20754c34c32777b890361c2c1541b89ea17ec8f993eb9ae718	2026-01-04 12:32:02.020311+00	20240718011735_observation_view_add_prompt_name_and_version	\N	\N	2026-01-04 12:32:02.018364+00	1
f75a40b1-34a3-42be-8531-c6b717cfb0a1	c1608bf5817cd052359ecd3ec19096b5091247931bdc740b91b4ec97bcedeab9	2026-01-04 12:32:02.02117+00	20240807111358_models_add_openai_gpt_4o_2024_08_06	\N	\N	2026-01-04 12:32:02.02055+00	1
6d6f8285-385d-4134-a7fd-e13661bbe546	8074e5eaabad18a6c7256d13fc7ae8639d038449d5dbb041143a95ca8d0730f1	2026-01-04 12:32:02.037399+00	20240807111359_add_organizations_main_migration	\N	\N	2026-01-04 12:32:02.021484+00	1
783b0537-13fa-4e59-85ad-f1fa3649ba06	ed0c0eb8eb8228cdac017ac8c31e31b6cc552161806825d38985afd9ee131e48	2026-01-04 12:32:02.038219+00	20240814223824_model_fix_text_embedding_3_large	\N	\N	2026-01-04 12:32:02.037644+00	1
634f47a9-7309-4581-967c-27370bce14b1	1f7d8f99ea875bcdd3962ab0a13902548718c781f103712051c43e43f3811bd1	2026-01-04 12:32:02.055408+00	20240917183009_remove_covered_indexes_09	\N	\N	2026-01-04 12:32:02.054535+00	1
3f38d304-1ee0-4e6b-90b0-616de46a788c	b390309bf9420d1873574d39bfafefe1cc9efb4720ff93aa67e7e6b5ecdb806c	2026-01-04 12:32:02.039816+00	20240814233029_dataset_items_drop_fkey_on_traces_and_observations	\N	\N	2026-01-04 12:32:02.038426+00	1
def9abe2-6a28-4551-a720-07fec99d971e	8c9d61879dd797ba022ada4f8c4ad9f20cf71f6c0e684096c0cdc55e25c192ac	2026-01-04 12:32:02.043208+00	20240815171916_add_comments	\N	\N	2026-01-04 12:32:02.040036+00	1
fcc2844b-2880-44ae-9e53-29b97d9d56c0	2c12c46fa776893cdc6d215b0c6dec0531dc7bf8474454bf8de4d842ede48f24	2026-01-04 12:32:02.06425+00	20241009042557_auth_add_created_at_for_gitlab	\N	\N	2026-01-04 12:32:02.063502+00	1
20aa09b4-50f6-4922-a494-86c8ee3dcc69	03510128bd751e5b3e5ea9599e2ad00cd7f24aed377607ebab1f56a639d73261	2026-01-04 12:32:02.044225+00	20240913095558_models_add_openai_o1_2024-09-12	\N	\N	2026-01-04 12:32:02.043567+00	1
b272764c-fc58-471f-9c9e-c3dec3b40f5b	11f5f9d27072f867214018c24408b28c53e0c2acdba79492d3fe0ba7509d4954	2026-01-04 12:32:02.05647+00	20240917183010_remove_covered_indexes_10	\N	\N	2026-01-04 12:32:02.05565+00	1
b23bc87f-35a2-4787-8ac2-314457f7a775	a5f429c21ec800e22377b61a192f208b8389718e4a950a4397c813b0af55adfc	2026-01-04 12:32:02.045133+00	20240913185822_account_add_refresh_token_expires_in	\N	\N	2026-01-04 12:32:02.0445+00	1
19772da0-78e2-4123-a050-73dbe234db0c	a91283903fab2398cf4119aee153ee91c04697fae59b653aa82d89413507502b	2026-01-04 12:32:02.046256+00	20240917183001_remove_covered_indexes_01	\N	\N	2026-01-04 12:32:02.045358+00	1
6d95baf8-2b25-40fa-99be-377b441a0233	16e13d2443a42819ab5693c1f11e1ff6503cea8c54462066c2ddd15e99b007fd	2026-01-04 12:32:02.047491+00	20240917183002_remove_covered_indexes_02	\N	\N	2026-01-04 12:32:02.046648+00	1
1c2d076f-76b0-414c-8eb7-5c161f619523	6654947f9c4c7d552dff50426840a1bdb54cb8def0ac9697603d0a3f97164338	2026-01-04 12:32:02.057593+00	20240917183011_remove_covered_indexes_11	\N	\N	2026-01-04 12:32:02.056681+00	1
2e29c65f-5055-499c-aeac-c31160e2ee2b	5901031d78a2cbb177c0446288169a4485bba062cfc9a0a614e709931e150433	2026-01-04 12:32:02.04856+00	20240917183003_remove_covered_indexes_03	\N	\N	2026-01-04 12:32:02.047716+00	1
61b09223-1e4e-4cd9-85da-89c3a5ffc46f	ad2dd180dc79f9253d1cbe523725b9ef6f2d39c9457ab3528131eb3ddc23d9cc	2026-01-04 12:32:02.04975+00	20240917183004_remove_covered_indexes_04	\N	\N	2026-01-04 12:32:02.048769+00	1
faf555b6-4693-4cf3-8d83-91825608c113	47bd20bb7c5bba3d252474ae5bdf69136e40796fb5b0b9f9e988b29bb32cdae1	2026-01-04 12:32:02.101191+00	20241024121500_add_generations_cost_backfill_background_migration	\N	\N	2026-01-04 12:32:02.100553+00	1
3d63c777-6468-4d3d-b793-04ce2d2119ab	81f3dbc2a12caef5e57f520b573742fe0d143b8914b47c43448638d4379fbd3d	2026-01-04 12:32:02.050783+00	20240917183005_remove_covered_indexes_05	\N	\N	2026-01-04 12:32:02.049949+00	1
9fa01f7a-43d0-45f3-baaa-0da8ed6affce	c4120d71f357eb5571b101e13961534009a45f5a3baefe51ac72f5cc1c31affb	2026-01-04 12:32:02.058616+00	20240917183012_remove_covered_indexes_12	\N	\N	2026-01-04 12:32:02.057815+00	1
d4dbc51c-89f7-4d26-a4bb-12698d717ea8	7abe1457f2e45389e5b7b1cb321ea6e487bbe02cd5820186d681bdbc28668e2f	2026-01-04 12:32:02.052131+00	20240917183006_remove_covered_indexes_06	\N	\N	2026-01-04 12:32:02.051167+00	1
5b22c71e-4a59-48bf-814d-73f02bc78cad	851e507a8c51f16008faff917f9e457e321f4b090f6f197343683a837234f8f5	2026-01-04 12:32:02.053178+00	20240917183007_remove_covered_indexes_07	\N	\N	2026-01-04 12:32:02.052352+00	1
cd03a15a-3995-4d98-b5e2-c9ee23cfa555	58551031c2a3bbd0325b2610234e2316ee4c1d704ff42e402d65edd74ca5d120	2026-01-04 12:32:02.065056+00	20241009110720_scores_add_nullable_queue_id_column	\N	\N	2026-01-04 12:32:02.064477+00	1
c9bfc9cd-68de-4869-9831-87cedfcda9e7	4f2bdda069ce30156aea5ad798c399078ddbd54b6839cb5f72e2c5d946352a28	2026-01-04 12:32:02.054299+00	20240917183008_remove_covered_indexes_08	\N	\N	2026-01-04 12:32:02.053444+00	1
73cfff6c-a99d-4260-81e8-cc98dd711fb3	cd4fa2a3c044b78666d0fc0011d89a5467101aa4322daa7873907f144c70f595	2026-01-04 12:32:02.059684+00	20240917183013_remove_covered_indexes_13	\N	\N	2026-01-04 12:32:02.058829+00	1
c623d947-f522-4f07-9aa6-f363a06be4d7	484041b7622a917effc1d608423692a072aa9d59e686627b367e4b9e9cffeed3	2026-01-04 12:32:02.09001+00	20241023110145_update_claude_sonnet_35	\N	\N	2026-01-04 12:32:02.089354+00	1
21f081a3-8201-4639-9364-2fffccbc0dc1	d73184a6312e4e7bd67c689865f158eb03c3fda4acd2662aa38fc53ef7bd1052	2026-01-04 12:32:02.060759+00	20240917183014_remove_covered_indexes_14	\N	\N	2026-01-04 12:32:02.059924+00	1
5f594bb2-4e17-4ff2-a87d-c7be03257acd	0dbe91562f26fe8f61373f8447175b7ab7ca248f30b9dba95bd577697a2370d8	2026-01-04 12:32:02.07861+00	20241009113245_add_annotation_queue	\N	\N	2026-01-04 12:32:02.065301+00	1
c4cdd81c-ed77-4d3f-bae2-7ac716150dd7	6cd7928e5bf79f84180c78fdd7479bfd81f1aced40338b17b12924be899bc234	2026-01-04 12:32:02.061787+00	20240917183015_remove_covered_indexes_15	\N	\N	2026-01-04 12:32:02.060965+00	1
39efba9e-e4a0-4d6f-8cab-9370bbe2ae3a	af5309595ed33080851fffd2de4c38aa3159df1e89dac976c9f228942b774edb	2026-01-04 12:32:02.063255+00	20240917183016_remove_covered_indexes_16	\N	\N	2026-01-04 12:32:02.062124+00	1
6c6f263f-9435-47e4-a523-789405eb64a4	1473c5a5a9a83c6426e26cb71a3f78bff60527109eb8b7452d96afe76097012e	2026-01-04 12:32:02.079815+00	20241010120245_llm_keys_add_config	\N	\N	2026-01-04 12:32:02.078991+00	1
94b091be-67b0-4b65-a803-a8f471458f10	c4c3bcf2de95f7bfd8f19b53a4714f83520afa1117f251ed444d0a5322e7e217	2026-01-04 12:32:02.095085+00	20241024100928_add_prices_table	\N	\N	2026-01-04 12:32:02.090257+00	1
a400ee68-c810-467d-bda8-4d00383da9f2	bb520543fe657f6f0d129953ce797619e91db7479eb154b0e7f9d10664da13fd	2026-01-04 12:32:02.087923+00	20241015110145_prompts_config_to_JSON	\N	\N	2026-01-04 12:32:02.080073+00	1
798a35da-b8a1-44b1-ad79-a22b4324c561	ded2191a0871be7b5f9bba2c2f4385a756d567d2c6cf203e230fed2e872cb96a	2026-01-04 12:32:02.08899+00	20241022110145_add_claude_sonnet_35	\N	\N	2026-01-04 12:32:02.088222+00	1
9b43a698-a6f1-4a49-9b62-b8413d9abd89	cd444613bc0a52ab579553655a9f12655fdf02373ae2195a49c6cb86fec64a11	2026-01-04 12:32:02.103264+00	20241024173700_add_observations_pg_to_ch_background_migration	\N	\N	2026-01-04 12:32:02.10245+00	1
5a1d270a-8d1a-4d4a-bbb9-dafeea7a9862	44896f4896bfbfc0d1e7157def5d73912c40a49bc76334e71f7e4c9f385788dd	2026-01-04 12:32:02.100305+00	20241024111800_add_background_migrations_table	\N	\N	2026-01-04 12:32:02.095312+00	1
2194b021-e26c-4b0d-a770-5ef55bdeb1eb	df40a8b13f93c3f27304e151a2392b86dc6a1baaaa5979dad05b7fb7b5003f1c	2026-01-04 12:32:02.10216+00	20241024173000_add_traces_pg_to_ch_background_migration	\N	\N	2026-01-04 12:32:02.101551+00	1
f3707155-fd44-4454-82c3-589544f52a13	192d7a00675ac998fbb295d08478ded69b4513286f5e3244af9f3ad99633c9a0	2026-01-04 12:32:02.105673+00	20241029130802_prices_drop_excess_index	\N	\N	2026-01-04 12:32:02.104468+00	1
d3e38b99-59c9-49cf-9ac3-695601f1f7e4	5378729e79a3a38e8ff596e1c147116e4016aeef7e49c3b08cb2dadb0f835bab	2026-01-04 12:32:02.104174+00	20241024173800_add_scores_pg_to_ch_background_migration	\N	\N	2026-01-04 12:32:02.103533+00	1
6e979d2a-bd50-456e-bb8f-0b5d788169d4	ef4fc49956097b140e83f2851fd27a551937c35de2d2bce13f38f049d8ff4cfa	2026-01-04 12:32:02.106704+00	20241104111600_background_migrations_add_state_column	\N	\N	2026-01-04 12:32:02.106042+00	1
9d568f54-8bd5-4740-836e-33f43b121860	122dc03a7a54b31dbca09d8dfcc588d456cf15b7ef10691512fc384a79780683	2026-01-04 12:32:02.10815+00	20241105110900_add_claude_haiku_35	\N	\N	2026-01-04 12:32:02.106953+00	1
e1e8b00b-e3a2-4b57-b9e2-64b3118c10cc	5b702f5f10383113f05ee768a48c99dc6e3b8040899d9b814452a94a38aec33d	2026-01-04 12:32:02.117726+00	20241106122605_add_media_tables	\N	\N	2026-01-04 12:32:02.10841+00	1
1e23f7b2-298c-48d5-95f7-b50804043bd5	e6521663ec43b43a44681506fe0528386be64f557d51bb379ff564b908f8c715	2026-01-04 12:32:02.118894+00	20241114175010_job_executions_add_observation_dataset_item_cols	\N	\N	2026-01-04 12:32:02.117964+00	1
fecd019b-6bda-4ef1-859e-74ac82128136	ed1e394c590f6c66218a1c2d41558add7ee9e7ff67d86252a9abb580e5583b9b	2026-01-04 12:32:02.120107+00	20241125124029_add_chatgpt_4o_prices	\N	\N	2026-01-04 12:32:02.119131+00	1
\.


--
-- Data for Name: annotation_queue_items; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.annotation_queue_items (id, queue_id, object_id, object_type, status, locked_at, locked_by_user_id, annotator_user_id, completed_at, project_id, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: annotation_queues; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.annotation_queues (id, name, description, score_config_ids, project_id, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: api_keys; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.api_keys (id, created_at, note, public_key, hashed_secret_key, display_secret_key, last_used_at, expires_at, project_id, fast_hashed_secret_key) FROM stdin;
\.


--
-- Data for Name: audit_logs; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.audit_logs (id, created_at, updated_at, user_id, project_id, resource_type, resource_id, action, before, after, org_id, user_org_role, user_project_role) FROM stdin;
\.


--
-- Data for Name: background_migrations; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.background_migrations (id, name, script, args, finished_at, failed_at, failed_reason, worker_id, locked_at, state) FROM stdin;
32859a35-98f5-4a4a-b438-ebc579349e00	20241024_1216_add_generations_cost_backfill	addGenerationsCostBackfill	{}	\N	\N	\N	\N	\N	{}
5960f22a-748f-480c-b2f3-bc4f9d5d84bc	20241024_1730_migrate_traces_from_pg_to_ch	migrateTracesFromPostgresToClickhouse	{}	\N	\N	\N	\N	\N	{}
7526e7c9-0026-4595-af2c-369dfd9176ec	20241024_1737_migrate_observations_from_pg_to_ch	migrateObservationsFromPostgresToClickhouse	{}	\N	\N	\N	\N	\N	{}
94e50334-50d3-4e49-ad2e-9f6d92c85ef7	20241024_1738_migrate_scores_from_pg_to_ch	migrateScoresFromPostgresToClickhouse	{}	\N	\N	\N	\N	\N	{}
\.


--
-- Data for Name: batch_exports; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.batch_exports (id, created_at, updated_at, project_id, user_id, finished_at, expires_at, name, status, query, format, url, log) FROM stdin;
\.


--
-- Data for Name: comments; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.comments (id, project_id, object_type, object_id, created_at, updated_at, content, author_user_id) FROM stdin;
\.


--
-- Data for Name: cron_jobs; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.cron_jobs (name, last_run, state, job_started_at) FROM stdin;
\.


--
-- Data for Name: dataset_items; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.dataset_items (id, input, expected_output, source_observation_id, dataset_id, created_at, updated_at, status, source_trace_id, metadata, project_id) FROM stdin;
\.


--
-- Data for Name: dataset_run_items; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.dataset_run_items (id, dataset_run_id, dataset_item_id, observation_id, created_at, updated_at, trace_id, project_id) FROM stdin;
\.


--
-- Data for Name: dataset_runs; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.dataset_runs (id, name, dataset_id, created_at, updated_at, metadata, description, project_id) FROM stdin;
\.


--
-- Data for Name: datasets; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.datasets (id, name, project_id, created_at, updated_at, description, metadata) FROM stdin;
\.


--
-- Data for Name: eval_templates; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.eval_templates (id, created_at, updated_at, project_id, name, version, prompt, model, model_params, vars, output_schema, provider) FROM stdin;
\.


--
-- Data for Name: events; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.events (id, created_at, updated_at, project_id, data, url, method, headers) FROM stdin;
\.


--
-- Data for Name: job_configurations; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.job_configurations (id, created_at, updated_at, project_id, job_type, eval_template_id, score_name, filter, target_object, variable_mapping, sampling, delay, status) FROM stdin;
\.


--
-- Data for Name: job_executions; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.job_executions (id, created_at, updated_at, project_id, job_configuration_id, status, start_time, end_time, error, job_input_trace_id, job_output_score_id, job_input_dataset_item_id, job_input_observation_id) FROM stdin;
\.


--
-- Data for Name: llm_api_keys; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.llm_api_keys (id, created_at, updated_at, provider, display_secret_key, secret_key, project_id, base_url, adapter, custom_models, with_default_models, config) FROM stdin;
\.


--
-- Data for Name: media; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.media (id, sha_256_hash, project_id, created_at, updated_at, uploaded_at, upload_http_status, upload_http_error, bucket_path, bucket_name, content_type, content_length) FROM stdin;
\.


--
-- Data for Name: membership_invitations; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.membership_invitations (id, email, project_id, invited_by_user_id, created_at, updated_at, org_id, org_role, project_role) FROM stdin;
\.


--
-- Data for Name: models; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.models (id, created_at, updated_at, project_id, model_name, match_pattern, start_date, input_price, output_price, total_price, unit, tokenizer_config, tokenizer_id) FROM stdin;
clrntkjgy000f08jx79v9g1xj	2026-01-04 12:32:01.734	2026-01-04 12:32:01.734	\N	gpt-4	(?i)^(gpt-4)$	\N	0.000030000000000000000000000000	0.000060000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4", "tokensPerMessage": 3}	openai
clrkwk4cc000908l537kl0rx3	2026-01-04 12:32:01.734	2026-01-04 12:32:01.734	\N	gpt-4-0613	(?i)^(gpt-4-0613)$	\N	0.000030000000000000000000000000	0.000060000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4-0613", "tokensPerMessage": 3}	openai
clrntkjgy000e08jx4x6uawoo	2026-01-04 12:32:01.734	2026-01-04 12:32:01.734	\N	gpt-4-0314	(?i)^(gpt-4-0314)$	\N	0.000030000000000000000000000000	0.000060000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4-0314", "tokensPerMessage": 3}	openai
clrkvyzgw000308jue4hse4j9	2026-01-04 12:32:01.734	2026-01-04 12:32:01.734	\N	gpt-4-32k	(?i)^(gpt-4-32k)$	\N	0.000060000000000000000000000000	0.000120000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4-32k", "tokensPerMessage": 3}	openai
clrkwk4cb000108l5hwwh3zdi	2026-01-04 12:32:01.734	2026-01-04 12:32:01.734	\N	gpt-4-32k-0613	(?i)^(gpt-4-32k-0613)$	\N	0.000060000000000000000000000000	0.000120000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4-32k-0613", "tokensPerMessage": 3}	openai
clrntkjgy000d08jx0p4y9h4l	2026-01-04 12:32:01.734	2026-01-04 12:32:01.734	\N	gpt-4-32k-0314	(?i)^(gpt-4-32k-0314)$	\N	0.000060000000000000000000000000	0.000120000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4-32k-0314", "tokensPerMessage": 3}	openai
clrkwk4cc000a08l562uc3s9g	2026-01-04 12:32:01.734	2026-01-04 12:32:01.734	\N	gpt-3.5-turbo-instruct	(?i)^(gpt-)(35|3.5)(-turbo-instruct)$	\N	0.000001500000000000000000000000	0.000002000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-3.5-turbo", "tokensPerMessage": 3}	openai
clrkwk4cb000408l576jl7koo	2026-01-04 12:32:01.734	2026-01-04 12:32:01.734	\N	gpt-3.5-turbo	(?i)^(gpt-)(35|3.5)(-turbo)$	2023-11-06 00:00:00	0.000001000000000000000000000000	0.000002000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-3.5-turbo", "tokensPerMessage": 3}	openai
clrkwk4cb000208l59yvb9yq8	2026-01-04 12:32:01.734	2026-01-04 12:32:01.734	\N	gpt-3.5-turbo-1106	(?i)^(gpt-)(35|3.5)(-turbo-1106)$	\N	0.000001000000000000000000000000	0.000002000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-3.5-turbo-1106", "tokensPerMessage": 3}	openai
clrntkjgy000c08jxesb30p3f	2026-01-04 12:32:01.734	2026-01-04 12:32:01.734	\N	gpt-3.5-turbo	(?i)^(gpt-)(35|3.5)(-turbo)$	2023-06-27 00:00:00	0.000001500000000000000000000000	0.000002000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-3.5-turbo", "tokensPerMessage": 3}	openai
clrkwk4cc000808l51xmk4uic	2026-01-04 12:32:01.734	2026-01-04 12:32:01.734	\N	gpt-3.5-turbo-0613	(?i)^(gpt-)(35|3.5)(-turbo-0613)$	\N	0.000001500000000000000000000000	0.000002000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-3.5-turbo-0613", "tokensPerMessage": 3}	openai
clrntkjgy000b08jx769q1bah	2026-01-04 12:32:01.734	2026-01-04 12:32:01.734	\N	gpt-3.5-turbo	(?i)^(gpt-)(35|3.5)(-turbo)$	\N	0.000002000000000000000000000000	0.000002000000000000000000000000	\N	TOKENS	{"tokensPerName": -1, "tokenizerModel": "gpt-3.5-turbo", "tokensPerMessage": 4}	openai
clrntkjgy000a08jx4e062mr0	2026-01-04 12:32:01.734	2026-01-04 12:32:01.734	\N	gpt-3.5-turbo-0301	(?i)^(gpt-)(35|3.5)(-turbo-0301)$	\N	0.000002000000000000000000000000	0.000002000000000000000000000000	\N	TOKENS	{"tokensPerName": -1, "tokenizerModel": "gpt-3.5-turbo-0301", "tokensPerMessage": 4}	openai
clrntjt89000908jwhvkz5crm	2026-01-04 12:32:01.739	2026-01-04 12:32:01.739	\N	text-embedding-ada-002	(?i)^(text-embedding-ada-002)$	2022-12-06 00:00:00	\N	\N	0.000000100000000000000000000000	TOKENS	{"tokenizerModel": "text-embedding-ada-002"}	openai
clrntjt89000908jwhvkz5crg	2026-01-04 12:32:01.739	2026-01-04 12:32:01.739	\N	text-embedding-ada-002-v2	(?i)^(text-embedding-ada-002-v2)$	2022-12-06 00:00:00	\N	\N	0.000000100000000000000000000000	TOKENS	{"tokenizerModel": "text-embedding-ada-002"}	openai
clrntjt89000108jwcou1af71	2026-01-04 12:32:01.739	2026-01-04 12:32:01.739	\N	text-ada-001	(?i)^(text-ada-001)$	\N	\N	\N	0.000004000000000000000000000000	TOKENS	{"tokenizerModel": "text-ada-001"}	openai
clrntjt89000208jwawjr894q	2026-01-04 12:32:01.739	2026-01-04 12:32:01.739	\N	text-babbage-001	(?i)^(text-babbage-001)$	\N	\N	\N	0.000000500000000000000000000000	TOKENS	{"tokenizerModel": "text-babbage-001"}	openai
clrkvx5gp000108juaogs54ea	2026-01-04 12:32:01.734	2026-01-04 12:32:01.734	\N	gpt-4-turbo-vision	(?i)^(gpt-4(-\\d{4})?-vision-preview)$	\N	0.000010000000000000000000000000	0.000030000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4-vision-preview", "tokensPerMessage": 3}	openai
clrntjt89000308jw0jtfa4rs	2026-01-04 12:32:01.739	2026-01-04 12:32:01.739	\N	text-curie-001	(?i)^(text-curie-001)$	\N	\N	\N	0.000020000000000000000000000000	TOKENS	{"tokenizerModel": "text-curie-001"}	openai
clrntjt89000408jwc2c93h6i	2026-01-04 12:32:01.739	2026-01-04 12:32:01.739	\N	text-davinci-001	(?i)^(text-davinci-001)$	\N	\N	\N	0.000020000000000000000000000000	TOKENS	{"tokenizerModel": "text-davinci-001"}	openai
clrntjt89000508jw192m64qi	2026-01-04 12:32:01.739	2026-01-04 12:32:01.739	\N	text-davinci-002	(?i)^(text-davinci-002)$	\N	\N	\N	0.000020000000000000000000000000	TOKENS	{"tokenizerModel": "text-davinci-002"}	openai
clrntjt89000608jw4m3x5s55	2026-01-04 12:32:01.739	2026-01-04 12:32:01.739	\N	text-davinci-003	(?i)^(text-davinci-003)$	\N	\N	\N	0.000020000000000000000000000000	TOKENS	{"tokenizerModel": "text-davinci-003"}	openai
clruwn3pc00010al7bl611c8o	2026-01-04 12:32:01.74	2026-01-04 12:32:01.74	\N	text-embedding-3-small	(?i)^(text-embedding-3-small)$	\N	\N	\N	0.000000020000000000000000000000	TOKENS	{"tokenizerModel": "text-embedding-ada-002"}	openai
clruwnahl00030al7ab9rark7	2026-01-04 12:32:01.74	2026-01-04 12:32:01.74	\N	gpt-3.5-turbo-0125	(?i)^(gpt-)(35|3.5)(-turbo-0125)$	\N	0.000000500000000000000000000000	0.000001500000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-3.5-turbo", "tokensPerMessage": 3}	openai
clruwnahl00050al796ck3p44	2026-01-04 12:32:01.74	2026-01-04 12:32:01.74	\N	gpt-4-0125-preview	(?i)^(gpt-4-0125-preview)$	\N	0.000010000000000000000000000000	0.000030000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4", "tokensPerMessage": 3}	openai
clruwnahl00060al74fcfehas	2026-01-04 12:32:01.74	2026-01-04 12:32:01.74	\N	gpt-4-turbo-preview	(?i)^(gpt-4-turbo-preview)$	\N	0.000030000000000000000000000000	0.000060000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4", "tokensPerMessage": 3}	openai
clrs2dnql000108l46vo0gp2t	2026-01-04 12:32:01.74	2026-01-04 12:32:01.74	\N	babbage-002	(?i)^(babbage-002)$	\N	0.000000400000000000000000000000	0.000001600000000000000000000000	\N	TOKENS	{"tokenizerModel": "babbage-002"}	openai
clrs2ds35000208l4g4b0hi3u	2026-01-04 12:32:01.74	2026-01-04 12:32:01.74	\N	davinci-002	(?i)^(davinci-002)$	\N	0.000006000000000000000000000000	0.000012000000000000000000000000	\N	TOKENS	{"tokenizerModel": "davinci-002"}	openai
clrnwbota000908jsgg9mb1ml	2026-01-04 12:32:01.743	2026-01-04 12:32:01.743	\N	claude-instant-1	(?i)^(claude-instant-1)$	\N	0.000001630000000000000000000000	0.000005510000000000000000000000	\N	TOKENS	\N	claude
clrnwb41q000308jsfrac9uh6	2026-01-04 12:32:01.743	2026-01-04 12:32:01.743	\N	claude-instant-1.2	(?i)^(claude-instant-1.2)$	\N	0.000001630000000000000000000000	0.000005510000000000000000000000	\N	TOKENS	\N	claude
clrnwbd1m000508js4hxu6o7n	2026-01-04 12:32:01.743	2026-01-04 12:32:01.743	\N	claude-2.1	(?i)^(claude-2.1)$	\N	0.000008000000000000000000000000	0.000024000000000000000000000000	\N	TOKENS	\N	claude
clrnwb836000408jsallr6u11	2026-01-04 12:32:01.743	2026-01-04 12:32:01.743	\N	claude-2.0	(?i)^(claude-2.0)$	\N	0.000008000000000000000000000000	0.000024000000000000000000000000	\N	TOKENS	\N	claude
clrnwbg2b000608jse2pp4q2d	2026-01-04 12:32:01.743	2026-01-04 12:32:01.743	\N	claude-1.3	(?i)^(claude-1.3)$	\N	0.000008000000000000000000000000	0.000024000000000000000000000000	\N	TOKENS	\N	claude
clrnwbi9d000708jseiy44k26	2026-01-04 12:32:01.743	2026-01-04 12:32:01.743	\N	claude-1.2	(?i)^(claude-1.2)$	\N	0.000008000000000000000000000000	0.000024000000000000000000000000	\N	TOKENS	\N	claude
clrnwblo0000808jsc1385hdp	2026-01-04 12:32:01.743	2026-01-04 12:32:01.743	\N	claude-1.1	(?i)^(claude-1.1)$	\N	0.000008000000000000000000000000	0.000024000000000000000000000000	\N	TOKENS	\N	claude
cls08r8sq000308jq14ae96f0	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	ft:gpt-3.5-turbo-1106	(?i)^(ft:)(gpt-3.5-turbo-1106:)(.+)(:)(.*)(:)(.+)$	\N	0.000003000000000000000000000000	0.000006000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-3.5-turbo-1106", "tokensPerMessage": 3}	openai
cls08rp99000408jqepxoakjv	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	ft:gpt-3.5-turbo-0613	(?i)^(ft:)(gpt-3.5-turbo-0613:)(.+)(:)(.*)(:)(.+)$	\N	0.000012000000000000000000000000	0.000016000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-3.5-turbo-0613", "tokensPerMessage": 3}	openai
cls08rv9g000508jq5p4z4nlr	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	ft:davinci-002	(?i)^(ft:)(davinci-002:)(.+)(:)(.*)(:)(.+)$$	\N	0.000012000000000000000000000000	0.000012000000000000000000000000	\N	TOKENS	{"tokenizerModel": "davinci-002"}	openai
cls08s2bw000608jq57wj4un2	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	ft:babbage-002	(?i)^(ft:)(babbage-002:)(.+)(:)(.*)(:)(.+)$$	\N	0.000001600000000000000000000000	0.000001600000000000000000000000	\N	TOKENS	{"tokenizerModel": "babbage-002"}	openai
cls0k4lqt000008ky1o1s8wd5	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	gemini-pro	(?i)^(gemini-pro)(@[a-zA-Z0-9]+)?$	\N	0.000000250000000000000000000000	0.000000500000000000000000000000	\N	CHARACTERS	\N	\N
cls0jni4t000008jk3kyy803r	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	chat-bison-32k	(?i)^(chat-bison-32k)(@[a-zA-Z0-9]+)?$	\N	0.000000250000000000000000000000	0.000000500000000000000000000000	\N	CHARACTERS	\N	\N
cls0iv12d000108l251gf3038	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	chat-bison	(?i)^(chat-bison)(@[a-zA-Z0-9]+)?$	\N	0.000000250000000000000000000000	0.000000500000000000000000000000	\N	CHARACTERS	\N	\N
cls0jmjt3000108l83ix86w0d	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	text-bison-32k	(?i)^(text-bison-32k)(@[a-zA-Z0-9]+)?$	\N	0.000000250000000000000000000000	0.000000500000000000000000000000	\N	CHARACTERS	\N	\N
cls0juygp000308jk2a6x9my2	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	text-bison	(?i)^(text-bison)(@[a-zA-Z0-9]+)?$	\N	0.000000250000000000000000000000	0.000000500000000000000000000000	\N	CHARACTERS	\N	\N
cls0jungb000208jk12gm4gk1	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	text-unicorn	(?i)^(text-unicorn)(@[a-zA-Z0-9]+)?$	\N	0.000002500000000000000000000000	0.000007500000000000000000000000	\N	CHARACTERS	\N	\N
cls1nyj5q000208l33ne901d8	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	textembedding-gecko	(?i)^(textembedding-gecko)(@[a-zA-Z0-9]+)?$	\N	\N	\N	0.000000100000000000000000000000	CHARACTERS	\N	\N
cls1nyyjp000308l31gxy1bih	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	textembedding-gecko-multilingual	(?i)^(textembedding-gecko-multilingual)(@[a-zA-Z0-9]+)?$	\N	\N	\N	0.000000100000000000000000000000	CHARACTERS	\N	\N
cls1nzjt3000508l3dnwad3g0	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	code-gecko	(?i)^(code-gecko)(@[a-zA-Z0-9]+)?$	\N	0.000000250000000000000000000000	0.000000500000000000000000000000	\N	CHARACTERS	\N	\N
cls1nzwx4000608l38va7e4tv	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	code-bison	(?i)^(code-bison)(@[a-zA-Z0-9]+)?$	\N	0.000000250000000000000000000000	0.000000500000000000000000000000	\N	CHARACTERS	\N	\N
cls1o053j000708l39f8g4bgs	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	code-bison-32k	(?i)^(code-bison-32k)(@[a-zA-Z0-9]+)?$	\N	0.000000250000000000000000000000	0.000000500000000000000000000000	\N	CHARACTERS	\N	\N
cls0j33v1000008joagkc4lql	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	codechat-bison-32k	(?i)^(codechat-bison-32k)(@[a-zA-Z0-9]+)?$	\N	0.000000250000000000000000000000	0.000000500000000000000000000000	\N	CHARACTERS	\N	\N
cls0jmc9v000008l8ee6r3gsd	2026-01-04 12:32:01.744	2026-01-04 12:32:01.744	\N	codechat-bison	(?i)^(codechat-bison)(@[a-zA-Z0-9]+)?$	\N	0.000000250000000000000000000000	0.000000500000000000000000000000	\N	CHARACTERS	\N	\N
clrkwk4cb000308l5go4b6otm	2026-01-04 12:32:01.745	2026-01-04 12:32:01.745	\N	gpt-3.5-turbo-16k	(?i)^(gpt-)(35|3.5)(-turbo-16k)$	\N	0.000003000000000000000000000000	0.000004000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-3.5-turbo-16k", "tokensPerMessage": 3}	openai
clrntjt89000a08jw0gcdbd5a	2026-01-04 12:32:01.745	2026-01-04 12:32:01.745	\N	gpt-3.5-turbo-16k-0613	(?i)^(gpt-)(35|3.5)(-turbo-16k-0613)$	\N	0.000003000000000000000000000000	0.000004000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-3.5-turbo-16k-0613", "tokensPerMessage": 3}	openai
clruwnahl00040al78f1lb0at	2026-01-04 12:32:01.75	2026-01-04 12:32:01.75	\N	gpt-3.5-turbo	(?i)^(gpt-)(35|3.5)(-turbo)$	2024-02-16 00:00:00	0.000000500000000000000000000000	0.000001500000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-3.5-turbo", "tokensPerMessage": 3}	openai
clsk9lntu000008jwfc51bbqv	2026-01-04 12:32:01.75	2026-01-04 12:32:01.75	\N	gpt-3.5-turbo-16k	(?i)^(gpt-)(35|3.5)(-turbo-16k)$	2024-02-16 00:00:00	0.000000500000000000000000000000	0.000001500000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-3.5-turbo-16k", "tokensPerMessage": 3}	openai
clsnq07bn000008l4e46v1ll8	2026-01-04 12:32:01.754	2026-01-04 12:32:01.754	\N	gpt-4-turbo-preview	(?i)^(gpt-4-turbo-preview)$	2023-11-06 00:00:00	0.000010000000000000000000000000	0.000030000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4", "tokensPerMessage": 3}	openai
clruwn76700020al7gp8e4g4l	2026-01-04 12:32:01.74	2026-01-04 12:32:01.74	\N	text-embedding-3-large	(?i)^(text-embedding-3-large)$	\N	\N	\N	0.000000130000000000000000000000	TOKENS	{"tokenizerModel": "text-embedding-ada-002"}	openai
cluv2sjeo000008ih0fv23hi0	2026-01-04 12:32:01.829	2026-01-04 12:32:01.829	\N	gemini-1.0-pro-latest	(?i)^(gemini-1.0-pro-latest)(@[a-zA-Z0-9]+)?$	\N	0.000000250000000000000000000000	0.000000500000000000000000000000	\N	CHARACTERS	\N	\N
cluv2subq000108ih2mlrga6a	2026-01-04 12:32:01.829	2026-01-04 12:32:01.829	\N	gemini-1.0-pro	(?i)^(gemini-1.0-pro)(@[a-zA-Z0-9]+)?$	2024-02-15 00:00:00	0.000000125000000000000000000000	0.000000375000000000000000000000	\N	CHARACTERS	\N	\N
cluv2sx04000208ihbek75lsz	2026-01-04 12:32:01.829	2026-01-04 12:32:01.829	\N	gemini-1.0-pro-001	(?i)^(gemini-1.0-pro-001)(@[a-zA-Z0-9]+)?$	2024-02-15 00:00:00	0.000000125000000000000000000000	0.000000375000000000000000000000	\N	CHARACTERS	\N	\N
cluv2szw0000308ihch3n79x7	2026-01-04 12:32:01.829	2026-01-04 12:32:01.829	\N	gemini-pro	(?i)^(gemini-pro)(@[a-zA-Z0-9]+)?$	2024-02-15 00:00:00	0.000000125000000000000000000000	0.000000375000000000000000000000	\N	CHARACTERS	\N	\N
cluv2t2x0000408ihfytl45l1	2026-01-04 12:32:01.829	2026-01-04 12:32:01.829	\N	gemini-1.5-pro-latest	(?i)^(gemini-1.5-pro-latest)(@[a-zA-Z0-9]+)?$	\N	0.000002500000000000000000000000	0.000007500000000000000000000000	\N	CHARACTERS	\N	\N
cluvpl4ls000008l6h2gx3i07	2026-01-04 12:32:01.832	2026-01-04 12:32:01.832	\N	gpt-4-turbo	(?i)^(gpt-4-turbo)$	\N	0.000010000000000000000000000000	0.000030000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4-1106-preview", "tokensPerMessage": 3}	openai
cluv2t5k3000508ih5kve9zag	2026-01-04 12:32:01.848	2026-01-04 12:32:01.848	\N	gpt-4-turbo-2024-04-09	(?i)^(gpt-4-turbo-2024-04-09)$	\N	0.000010000000000000000000000000	0.000030000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4-turbo-2024-04-09", "tokensPerMessage": 3}	openai
clrkvq6iq000008ju6c16gynt	2026-01-04 12:32:01.848	2026-01-04 12:32:01.848	\N	gpt-4-1106-preview	(?i)^(gpt-4-1106-preview)$	\N	0.000010000000000000000000000000	0.000030000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4-1106-preview", "tokensPerMessage": 3}	openai
clv2o2x0p000008jsf9afceau	2026-01-04 12:32:01.848	2026-01-04 12:32:01.848	\N	 gpt-4-preview	(?i)^(gpt-4-preview)$	\N	0.000010000000000000000000000000	0.000030000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4-turbo-preview", "tokensPerMessage": 3}	openai
b9854a5c92dc496b997d99d20	2026-01-04 12:32:01.88	2026-01-04 12:32:01.88	\N	gpt-4o	(?i)^(gpt-4o)$	\N	0.000005000000000000000000000000	0.000015000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4o", "tokensPerMessage": 3}	openai
b9854a5c92dc496b997d99d21	2026-01-04 12:32:01.88	2026-01-04 12:32:01.88	\N	gpt-4o-2024-05-13	(?i)^(gpt-4o-2024-05-13)$	\N	0.000005000000000000000000000000	0.000015000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4o-2024-05-13", "tokensPerMessage": 3}	openai
clx30djsn0000w9mzebiv41we	2026-01-04 12:32:01.97	2026-01-04 12:32:01.97	\N	gemini-1.5-flash	(?i)^(gemini-1.5-flash)(@[a-zA-Z0-9]+)?$	\N	\N	\N	\N	CHARACTERS	\N	\N
clx30hkrx0000w9mz7lqi0ial	2026-01-04 12:32:01.97	2026-01-04 12:32:01.97	\N	gemini-1.5-pro	(?i)^(gemini-1.5-pro)(@[a-zA-Z0-9]+)?$	\N	\N	\N	\N	CHARACTERS	\N	\N
cm3x0p8ev000008kyd96800c8	2026-01-04 12:32:02.119	2026-01-04 12:32:02.119	\N	chatgpt-4o-latest	(?i)^(chatgpt-4o-latest)$	\N	0.000005000000000000000000000000	0.000015000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4o", "tokensPerMessage": 3}	openai
cltr0w45b000008k1407o9qv1	2026-01-04 12:32:01.795	2026-01-04 12:32:01.795	\N	claude-3-haiku-20240307	(?i)^(claude-3-haiku-20240307|anthropic\\.claude-3-haiku-20240307-v1:0|claude-3-haiku@20240307)$	\N	0.000000250000000000000000000000	0.000001250000000000000000000000	\N	TOKENS	\N	claude
cltgy0pp6000108le56se7bl3	2026-01-04 12:32:01.787	2026-01-04 12:32:01.787	\N	claude-3-sonnet-20240229	(?i)^(claude-3-sonnet-20240229|anthropic\\.claude-3-sonnet-20240229-v1:0|claude-3-sonnet@20240229)$	\N	0.000003000000000000000000000000	0.000015000000000000000000000000	\N	TOKENS	\N	claude
cltgy0iuw000008le3vod1hhy	2026-01-04 12:32:01.787	2026-01-04 12:32:01.787	\N	claude-3-opus-20240229	(?i)^(claude-3-opus-20240229|anthropic\\.claude-3-opus-20240229-v1:0|claude-3-opus@20240229)$	\N	0.000015000000000000000000000000	0.000075000000000000000000000000	\N	TOKENS	\N	claude
clxt0n0m60000pumz1j5b7zsf	2026-01-04 12:32:01.993	2026-01-04 12:32:01.993	\N	claude-3-5-sonnet-20240620	(?i)^(claude-3-5-sonnet-20240620|anthropic\\.claude-3-5-sonnet-20240620-v1:0|claude-3-5-sonnet@20240620)$	\N	0.000003000000000000000000000000	0.000015000000000000000000000000	\N	TOKENS	\N	claude
clyrjp56f0000t0mzapoocd7u	2026-01-04 12:32:02.006	2026-01-04 12:32:02.006	\N	gpt-4o-mini	(?i)^(gpt-4o-mini)$	\N	0.000000150000000000000000000000	0.000000600000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4o", "tokensPerMessage": 3}	openai
clyrjpbe20000t0mzcbwc42rg	2026-01-04 12:32:02.006	2026-01-04 12:32:02.006	\N	gpt-4o-mini-2024-07-18	(?i)^(gpt-4o-mini-2024-07-18)$	\N	0.000000150000000000000000000000	0.000000600000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4o", "tokensPerMessage": 3}	openai
clzjr85f70000ymmzg7hqffra	2026-01-04 12:32:02.021	2026-01-04 12:32:02.021	\N	gpt-4o-2024-08-06	(?i)^(gpt-4o-2024-08-06)$	\N	0.000002500000000000000000000000	0.000010000000000000000000000000	\N	TOKENS	{"tokensPerName": 1, "tokenizerModel": "gpt-4o", "tokensPerMessage": 3}	openai
cm10ivcdp0000gix7lelmbw80	2026-01-04 12:32:02.044	2026-01-04 12:32:02.044	\N	o1-preview	(?i)^(o1-preview)$	\N	0.000015000000000000000000000000	0.000060000000000000000000000000	\N	TOKENS	\N	\N
cm10ivo130000n8x7qopcjjcg	2026-01-04 12:32:02.044	2026-01-04 12:32:02.044	\N	o1-preview-2024-09-12	(?i)^(o1-preview-2024-09-12)$	\N	0.000015000000000000000000000000	0.000060000000000000000000000000	\N	TOKENS	\N	\N
cm10ivwo40000r1x7gg3syjq0	2026-01-04 12:32:02.044	2026-01-04 12:32:02.044	\N	o1-mini	(?i)^(o1-mini)$	\N	0.000003000000000000000000000000	0.000012000000000000000000000000	\N	TOKENS	\N	\N
cm10iw6p20000wgx7it1hlb22	2026-01-04 12:32:02.044	2026-01-04 12:32:02.044	\N	o1-mini-2024-09-12	(?i)^(o1-mini-2024-09-12)$	\N	0.000003000000000000000000000000	0.000012000000000000000000000000	\N	TOKENS	\N	\N
cm2krz1uf000208jjg5653iud	2026-01-04 12:32:02.089	2026-01-04 12:32:02.089	\N	claude-3.5-sonnet-20241022	(?i)^(claude-3-5-sonnet-20241022|anthropic\\.claude-3-5-sonnet-20241022-v2:0|claude-3-5-sonnet-V2@20241022)$	\N	0.000003000000000000000000000000	0.000015000000000000000000000000	\N	TOKENS	\N	claude
cm2ks2vzn000308jjh4ze1w7q	2026-01-04 12:32:02.089	2026-01-04 12:32:02.089	\N	claude-3.5-sonnet-latest	(?i)^(claude-3-5-sonnet-latest)$	\N	0.000003000000000000000000000000	0.000015000000000000000000000000	\N	TOKENS	\N	claude
cm34aq60d000207ml0j1h31ar	2026-01-04 12:32:02.107	2026-01-04 12:32:02.107	\N	claude-3-5-haiku-20241022	(?i)^(claude-3-5-haiku-20241022|anthropic\\.claude-3-5-haiku-20241022-v1:0|claude-3-5-haiku-V1@20241022)$	\N	0.000001000000000000000000000000	0.000005000000000000000000000000	\N	TOKENS	\N	claude
cm34aqb9h000307ml6nypd618	2026-01-04 12:32:02.107	2026-01-04 12:32:02.107	\N	claude-3.5-haiku-latest	(?i)^(claude-3-5-haiku-latest)$	\N	0.000001000000000000000000000000	0.000005000000000000000000000000	\N	TOKENS	\N	claude
\.


--
-- Data for Name: observation_media; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.observation_media (id, project_id, created_at, updated_at, media_id, trace_id, observation_id, field) FROM stdin;
\.


--
-- Data for Name: observations; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.observations (id, name, start_time, end_time, parent_observation_id, type, trace_id, metadata, model, "modelParameters", input, output, level, status_message, completion_start_time, completion_tokens, prompt_tokens, total_tokens, version, project_id, created_at, unit, prompt_id, input_cost, output_cost, total_cost, internal_model, updated_at, calculated_input_cost, calculated_output_cost, calculated_total_cost, internal_model_id) FROM stdin;
\.


--
-- Data for Name: organization_memberships; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.organization_memberships (id, org_id, user_id, role, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: organizations; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.organizations (id, name, created_at, updated_at, cloud_config) FROM stdin;
\.


--
-- Data for Name: posthog_integrations; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.posthog_integrations (project_id, encrypted_posthog_api_key, posthog_host_name, last_sync_at, enabled, created_at) FROM stdin;
\.


--
-- Data for Name: prices; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.prices (id, created_at, updated_at, model_id, usage_type, price) FROM stdin;
cm34ax6mc000008jkfqed92mb	2026-01-04 12:32:02.107	2026-01-04 12:32:02.107	cm34aq60d000207ml0j1h31ar	input	0.000001000000000000000000000000
cm34axb2o000108jk09wn9b47	2026-01-04 12:32:02.107	2026-01-04 12:32:02.107	cm34aqb9h000307ml6nypd618	input	0.000001000000000000000000000000
cm34axeie000208jk8b2ke2t8	2026-01-04 12:32:02.107	2026-01-04 12:32:02.107	cm34aq60d000207ml0j1h31ar	output	0.000005000000000000000000000000
cm34axi67000308jk7x1a7qko	2026-01-04 12:32:02.107	2026-01-04 12:32:02.107	cm34aqb9h000307ml6nypd618	output	0.000005000000000000000000000000
cm3x0psrz000108kydpxg9o2k	2026-01-04 12:32:02.119	2026-01-04 12:32:02.119	cm3x0p8ev000008kyd96800c8	input	0.000005000000000000000000000000
cm3x0pyt7000208ky8737gdla	2026-01-04 12:32:02.119	2026-01-04 12:32:02.119	cm3x0p8ev000008kyd96800c8	output	0.000015000000000000000000000000
\.


--
-- Data for Name: project_memberships; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.project_memberships (project_id, user_id, created_at, updated_at, org_membership_id, role) FROM stdin;
\.


--
-- Data for Name: projects; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.projects (id, created_at, name, updated_at, org_id) FROM stdin;
\.


--
-- Data for Name: prompts; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.prompts (id, created_at, updated_at, project_id, created_by, name, version, is_active, config, prompt, type, tags, labels) FROM stdin;
\.


--
-- Data for Name: score_configs; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.score_configs (id, created_at, updated_at, project_id, name, data_type, is_archived, min_value, max_value, categories, description) FROM stdin;
\.


--
-- Data for Name: scores; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.scores (id, "timestamp", name, value, observation_id, trace_id, comment, source, project_id, author_user_id, config_id, data_type, string_value, created_at, updated_at, queue_id) FROM stdin;
\.


--
-- Data for Name: sso_configs; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.sso_configs (domain, created_at, updated_at, auth_provider, auth_config) FROM stdin;
\.


--
-- Data for Name: trace_media; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.trace_media (id, project_id, created_at, updated_at, media_id, trace_id, field) FROM stdin;
\.


--
-- Data for Name: trace_sessions; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.trace_sessions (id, created_at, updated_at, project_id, bookmarked, public) FROM stdin;
\.


--
-- Data for Name: traces; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.traces (id, "timestamp", name, project_id, metadata, external_id, user_id, release, version, public, bookmarked, input, output, session_id, tags, created_at, updated_at) FROM stdin;
\.


--
-- Data for Name: users; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.users (id, name, email, email_verified, password, image, created_at, updated_at, feature_flags, admin) FROM stdin;
\.


--
-- Data for Name: verification_tokens; Type: TABLE DATA; Schema: public; Owner: squads
--

COPY public.verification_tokens (identifier, token, expires) FROM stdin;
\.


--
-- Name: Account Account_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public."Account"
    ADD CONSTRAINT "Account_pkey" PRIMARY KEY (id);


--
-- Name: Session Session_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_pkey" PRIMARY KEY (id);


--
-- Name: _prisma_migrations _prisma_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public._prisma_migrations
    ADD CONSTRAINT _prisma_migrations_pkey PRIMARY KEY (id);


--
-- Name: annotation_queue_items annotation_queue_items_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.annotation_queue_items
    ADD CONSTRAINT annotation_queue_items_pkey PRIMARY KEY (id);


--
-- Name: annotation_queues annotation_queues_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.annotation_queues
    ADD CONSTRAINT annotation_queues_pkey PRIMARY KEY (id);


--
-- Name: api_keys api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_pkey PRIMARY KEY (id);


--
-- Name: audit_logs audit_logs_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.audit_logs
    ADD CONSTRAINT audit_logs_pkey PRIMARY KEY (id);


--
-- Name: background_migrations background_migrations_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.background_migrations
    ADD CONSTRAINT background_migrations_pkey PRIMARY KEY (id);


--
-- Name: batch_exports batch_exports_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.batch_exports
    ADD CONSTRAINT batch_exports_pkey PRIMARY KEY (id);


--
-- Name: comments comments_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_pkey PRIMARY KEY (id);


--
-- Name: cron_jobs cron_jobs_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.cron_jobs
    ADD CONSTRAINT cron_jobs_pkey PRIMARY KEY (name);


--
-- Name: dataset_items dataset_items_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.dataset_items
    ADD CONSTRAINT dataset_items_pkey PRIMARY KEY (id, project_id);


--
-- Name: dataset_run_items dataset_run_items_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.dataset_run_items
    ADD CONSTRAINT dataset_run_items_pkey PRIMARY KEY (id, project_id);


--
-- Name: dataset_runs dataset_runs_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.dataset_runs
    ADD CONSTRAINT dataset_runs_pkey PRIMARY KEY (id, project_id);


--
-- Name: datasets datasets_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.datasets
    ADD CONSTRAINT datasets_pkey PRIMARY KEY (id, project_id);


--
-- Name: eval_templates eval_templates_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.eval_templates
    ADD CONSTRAINT eval_templates_pkey PRIMARY KEY (id);


--
-- Name: events events_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_pkey PRIMARY KEY (id);


--
-- Name: job_configurations job_configurations_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.job_configurations
    ADD CONSTRAINT job_configurations_pkey PRIMARY KEY (id);


--
-- Name: job_executions job_executions_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.job_executions
    ADD CONSTRAINT job_executions_pkey PRIMARY KEY (id);


--
-- Name: llm_api_keys llm_api_keys_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.llm_api_keys
    ADD CONSTRAINT llm_api_keys_pkey PRIMARY KEY (id);


--
-- Name: media media_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT media_pkey PRIMARY KEY (id);


--
-- Name: membership_invitations membership_invitations_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.membership_invitations
    ADD CONSTRAINT membership_invitations_pkey PRIMARY KEY (id);


--
-- Name: models models_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.models
    ADD CONSTRAINT models_pkey PRIMARY KEY (id);


--
-- Name: observation_media observation_media_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.observation_media
    ADD CONSTRAINT observation_media_pkey PRIMARY KEY (id);


--
-- Name: observations observations_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.observations
    ADD CONSTRAINT observations_pkey PRIMARY KEY (id);


--
-- Name: organization_memberships organization_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.organization_memberships
    ADD CONSTRAINT organization_memberships_pkey PRIMARY KEY (id);


--
-- Name: organizations organizations_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.organizations
    ADD CONSTRAINT organizations_pkey PRIMARY KEY (id);


--
-- Name: posthog_integrations posthog_integrations_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.posthog_integrations
    ADD CONSTRAINT posthog_integrations_pkey PRIMARY KEY (project_id);


--
-- Name: prices prices_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.prices
    ADD CONSTRAINT prices_pkey PRIMARY KEY (id);


--
-- Name: project_memberships project_memberships_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.project_memberships
    ADD CONSTRAINT project_memberships_pkey PRIMARY KEY (project_id, user_id);


--
-- Name: projects projects_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_pkey PRIMARY KEY (id);


--
-- Name: prompts prompts_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.prompts
    ADD CONSTRAINT prompts_pkey PRIMARY KEY (id);


--
-- Name: score_configs score_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.score_configs
    ADD CONSTRAINT score_configs_pkey PRIMARY KEY (id);


--
-- Name: scores scores_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.scores
    ADD CONSTRAINT scores_pkey PRIMARY KEY (id);


--
-- Name: sso_configs sso_configs_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.sso_configs
    ADD CONSTRAINT sso_configs_pkey PRIMARY KEY (domain);


--
-- Name: trace_media trace_media_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.trace_media
    ADD CONSTRAINT trace_media_pkey PRIMARY KEY (id);


--
-- Name: trace_sessions trace_sessions_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.trace_sessions
    ADD CONSTRAINT trace_sessions_pkey PRIMARY KEY (id, project_id);


--
-- Name: traces traces_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.traces
    ADD CONSTRAINT traces_pkey PRIMARY KEY (id);


--
-- Name: users users_pkey; Type: CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.users
    ADD CONSTRAINT users_pkey PRIMARY KEY (id);


--
-- Name: Account_provider_providerAccountId_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX "Account_provider_providerAccountId_key" ON public."Account" USING btree (provider, "providerAccountId");


--
-- Name: Account_user_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX "Account_user_id_idx" ON public."Account" USING btree (user_id);


--
-- Name: Session_session_token_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX "Session_session_token_key" ON public."Session" USING btree (session_token);


--
-- Name: annotation_queue_items_annotator_user_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX annotation_queue_items_annotator_user_id_idx ON public.annotation_queue_items USING btree (annotator_user_id);


--
-- Name: annotation_queue_items_created_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX annotation_queue_items_created_at_idx ON public.annotation_queue_items USING btree (created_at);


--
-- Name: annotation_queue_items_id_project_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX annotation_queue_items_id_project_id_idx ON public.annotation_queue_items USING btree (id, project_id);


--
-- Name: annotation_queue_items_object_id_object_type_project_id_que_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX annotation_queue_items_object_id_object_type_project_id_que_idx ON public.annotation_queue_items USING btree (object_id, object_type, project_id, queue_id);


--
-- Name: annotation_queue_items_project_id_queue_id_status_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX annotation_queue_items_project_id_queue_id_status_idx ON public.annotation_queue_items USING btree (project_id, queue_id, status);


--
-- Name: annotation_queues_id_project_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX annotation_queues_id_project_id_idx ON public.annotation_queues USING btree (id, project_id);


--
-- Name: annotation_queues_project_id_created_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX annotation_queues_project_id_created_at_idx ON public.annotation_queues USING btree (project_id, created_at);


--
-- Name: annotation_queues_project_id_name_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX annotation_queues_project_id_name_key ON public.annotation_queues USING btree (project_id, name);


--
-- Name: api_keys_fast_hashed_secret_key_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX api_keys_fast_hashed_secret_key_idx ON public.api_keys USING btree (fast_hashed_secret_key);


--
-- Name: api_keys_fast_hashed_secret_key_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX api_keys_fast_hashed_secret_key_key ON public.api_keys USING btree (fast_hashed_secret_key);


--
-- Name: api_keys_hashed_secret_key_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX api_keys_hashed_secret_key_idx ON public.api_keys USING btree (hashed_secret_key);


--
-- Name: api_keys_hashed_secret_key_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX api_keys_hashed_secret_key_key ON public.api_keys USING btree (hashed_secret_key);


--
-- Name: api_keys_id_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX api_keys_id_key ON public.api_keys USING btree (id);


--
-- Name: api_keys_project_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX api_keys_project_id_idx ON public.api_keys USING btree (project_id);


--
-- Name: api_keys_public_key_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX api_keys_public_key_idx ON public.api_keys USING btree (public_key);


--
-- Name: api_keys_public_key_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX api_keys_public_key_key ON public.api_keys USING btree (public_key);


--
-- Name: audit_logs_created_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX audit_logs_created_at_idx ON public.audit_logs USING btree (created_at);


--
-- Name: audit_logs_org_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX audit_logs_org_id_idx ON public.audit_logs USING btree (org_id);


--
-- Name: audit_logs_project_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX audit_logs_project_id_idx ON public.audit_logs USING btree (project_id);


--
-- Name: audit_logs_updated_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX audit_logs_updated_at_idx ON public.audit_logs USING btree (updated_at);


--
-- Name: audit_logs_user_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX audit_logs_user_id_idx ON public.audit_logs USING btree (user_id);


--
-- Name: background_migrations_name_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX background_migrations_name_key ON public.background_migrations USING btree (name);


--
-- Name: batch_exports_project_id_user_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX batch_exports_project_id_user_id_idx ON public.batch_exports USING btree (project_id, user_id);


--
-- Name: batch_exports_status_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX batch_exports_status_idx ON public.batch_exports USING btree (status);


--
-- Name: comments_project_id_object_type_object_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX comments_project_id_object_type_object_id_idx ON public.comments USING btree (project_id, object_type, object_id);


--
-- Name: dataset_items_created_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX dataset_items_created_at_idx ON public.dataset_items USING btree (created_at);


--
-- Name: dataset_items_dataset_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX dataset_items_dataset_id_idx ON public.dataset_items USING hash (dataset_id);


--
-- Name: dataset_items_source_observation_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX dataset_items_source_observation_id_idx ON public.dataset_items USING hash (source_observation_id);


--
-- Name: dataset_items_source_trace_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX dataset_items_source_trace_id_idx ON public.dataset_items USING hash (source_trace_id);


--
-- Name: dataset_items_updated_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX dataset_items_updated_at_idx ON public.dataset_items USING btree (updated_at);


--
-- Name: dataset_run_items_created_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX dataset_run_items_created_at_idx ON public.dataset_run_items USING btree (created_at);


--
-- Name: dataset_run_items_dataset_item_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX dataset_run_items_dataset_item_id_idx ON public.dataset_run_items USING hash (dataset_item_id);


--
-- Name: dataset_run_items_dataset_run_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX dataset_run_items_dataset_run_id_idx ON public.dataset_run_items USING hash (dataset_run_id);


--
-- Name: dataset_run_items_observation_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX dataset_run_items_observation_id_idx ON public.dataset_run_items USING hash (observation_id);


--
-- Name: dataset_run_items_trace_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX dataset_run_items_trace_id_idx ON public.dataset_run_items USING btree (trace_id);


--
-- Name: dataset_run_items_updated_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX dataset_run_items_updated_at_idx ON public.dataset_run_items USING btree (updated_at);


--
-- Name: dataset_runs_created_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX dataset_runs_created_at_idx ON public.dataset_runs USING btree (created_at);


--
-- Name: dataset_runs_dataset_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX dataset_runs_dataset_id_idx ON public.dataset_runs USING hash (dataset_id);


--
-- Name: dataset_runs_dataset_id_project_id_name_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX dataset_runs_dataset_id_project_id_name_key ON public.dataset_runs USING btree (dataset_id, project_id, name);


--
-- Name: dataset_runs_updated_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX dataset_runs_updated_at_idx ON public.dataset_runs USING btree (updated_at);


--
-- Name: datasets_created_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX datasets_created_at_idx ON public.datasets USING btree (created_at);


--
-- Name: datasets_project_id_name_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX datasets_project_id_name_key ON public.datasets USING btree (project_id, name);


--
-- Name: datasets_updated_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX datasets_updated_at_idx ON public.datasets USING btree (updated_at);


--
-- Name: eval_templates_project_id_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX eval_templates_project_id_id_idx ON public.eval_templates USING btree (project_id, id);


--
-- Name: eval_templates_project_id_name_version_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX eval_templates_project_id_name_version_key ON public.eval_templates USING btree (project_id, name, version);


--
-- Name: events_project_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX events_project_id_idx ON public.events USING btree (project_id);


--
-- Name: job_configurations_project_id_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX job_configurations_project_id_id_idx ON public.job_configurations USING btree (project_id, id);


--
-- Name: job_executions_created_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX job_executions_created_at_idx ON public.job_executions USING btree (created_at);


--
-- Name: job_executions_job_configuration_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX job_executions_job_configuration_id_idx ON public.job_executions USING btree (job_configuration_id);


--
-- Name: job_executions_job_input_trace_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX job_executions_job_input_trace_id_idx ON public.job_executions USING btree (job_input_trace_id);


--
-- Name: job_executions_job_output_score_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX job_executions_job_output_score_id_idx ON public.job_executions USING btree (job_output_score_id);


--
-- Name: job_executions_project_id_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX job_executions_project_id_id_idx ON public.job_executions USING btree (project_id, id);


--
-- Name: job_executions_project_id_status_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX job_executions_project_id_status_idx ON public.job_executions USING btree (project_id, status);


--
-- Name: job_executions_updated_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX job_executions_updated_at_idx ON public.job_executions USING btree (updated_at);


--
-- Name: llm_api_keys_id_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX llm_api_keys_id_key ON public.llm_api_keys USING btree (id);


--
-- Name: llm_api_keys_project_id_provider_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX llm_api_keys_project_id_provider_key ON public.llm_api_keys USING btree (project_id, provider);


--
-- Name: media_project_id_sha_256_hash_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX media_project_id_sha_256_hash_key ON public.media USING btree (project_id, sha_256_hash);


--
-- Name: membership_invitations_email_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX membership_invitations_email_idx ON public.membership_invitations USING btree (email);


--
-- Name: membership_invitations_id_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX membership_invitations_id_key ON public.membership_invitations USING btree (id);


--
-- Name: membership_invitations_org_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX membership_invitations_org_id_idx ON public.membership_invitations USING btree (org_id);


--
-- Name: membership_invitations_project_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX membership_invitations_project_id_idx ON public.membership_invitations USING btree (project_id);


--
-- Name: models_model_name_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX models_model_name_idx ON public.models USING btree (model_name);


--
-- Name: models_project_id_model_name_start_date_unit_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX models_project_id_model_name_start_date_unit_key ON public.models USING btree (project_id, model_name, start_date, unit);


--
-- Name: observation_media_project_id_observation_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX observation_media_project_id_observation_id_idx ON public.observation_media USING btree (project_id, observation_id);


--
-- Name: observation_media_project_id_trace_id_observation_id_media__key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX observation_media_project_id_trace_id_observation_id_media__key ON public.observation_media USING btree (project_id, trace_id, observation_id, media_id, field);


--
-- Name: observations_created_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX observations_created_at_idx ON public.observations USING btree (created_at);


--
-- Name: observations_id_project_id_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX observations_id_project_id_key ON public.observations USING btree (id, project_id);


--
-- Name: observations_internal_model_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX observations_internal_model_idx ON public.observations USING btree (internal_model);


--
-- Name: observations_model_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX observations_model_idx ON public.observations USING btree (model);


--
-- Name: observations_project_id_internal_model_start_time_unit_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX observations_project_id_internal_model_start_time_unit_idx ON public.observations USING btree (project_id, internal_model, start_time, unit);


--
-- Name: observations_project_id_prompt_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX observations_project_id_prompt_id_idx ON public.observations USING btree (project_id, prompt_id);


--
-- Name: observations_project_id_start_time_type_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX observations_project_id_start_time_type_idx ON public.observations USING btree (project_id, start_time, type);


--
-- Name: observations_prompt_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX observations_prompt_id_idx ON public.observations USING btree (prompt_id);


--
-- Name: observations_start_time_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX observations_start_time_idx ON public.observations USING btree (start_time);


--
-- Name: observations_trace_id_project_id_start_time_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX observations_trace_id_project_id_start_time_idx ON public.observations USING btree (trace_id, project_id, start_time);


--
-- Name: observations_trace_id_project_id_type_start_time_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX observations_trace_id_project_id_type_start_time_idx ON public.observations USING btree (trace_id, project_id, type, start_time);


--
-- Name: observations_type_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX observations_type_idx ON public.observations USING btree (type);


--
-- Name: organization_memberships_org_id_user_id_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX organization_memberships_org_id_user_id_key ON public.organization_memberships USING btree (org_id, user_id);


--
-- Name: organization_memberships_user_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX organization_memberships_user_id_idx ON public.organization_memberships USING btree (user_id);


--
-- Name: prices_model_id_usage_type_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX prices_model_id_usage_type_key ON public.prices USING btree (model_id, usage_type);


--
-- Name: project_memberships_org_membership_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX project_memberships_org_membership_id_idx ON public.project_memberships USING btree (org_membership_id);


--
-- Name: project_memberships_project_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX project_memberships_project_id_idx ON public.project_memberships USING btree (project_id);


--
-- Name: project_memberships_user_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX project_memberships_user_id_idx ON public.project_memberships USING btree (user_id);


--
-- Name: projects_org_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX projects_org_id_idx ON public.projects USING btree (org_id);


--
-- Name: prompts_created_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX prompts_created_at_idx ON public.prompts USING btree (created_at);


--
-- Name: prompts_project_id_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX prompts_project_id_id_idx ON public.prompts USING btree (project_id, id);


--
-- Name: prompts_project_id_name_version_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX prompts_project_id_name_version_key ON public.prompts USING btree (project_id, name, version);


--
-- Name: prompts_tags_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX prompts_tags_idx ON public.prompts USING gin (tags);


--
-- Name: prompts_updated_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX prompts_updated_at_idx ON public.prompts USING btree (updated_at);


--
-- Name: score_configs_categories_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX score_configs_categories_idx ON public.score_configs USING btree (categories);


--
-- Name: score_configs_created_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX score_configs_created_at_idx ON public.score_configs USING btree (created_at);


--
-- Name: score_configs_data_type_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX score_configs_data_type_idx ON public.score_configs USING btree (data_type);


--
-- Name: score_configs_id_project_id_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX score_configs_id_project_id_key ON public.score_configs USING btree (id, project_id);


--
-- Name: score_configs_is_archived_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX score_configs_is_archived_idx ON public.score_configs USING btree (is_archived);


--
-- Name: score_configs_project_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX score_configs_project_id_idx ON public.score_configs USING btree (project_id);


--
-- Name: score_configs_updated_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX score_configs_updated_at_idx ON public.score_configs USING btree (updated_at);


--
-- Name: scores_author_user_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX scores_author_user_id_idx ON public.scores USING btree (author_user_id);


--
-- Name: scores_config_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX scores_config_id_idx ON public.scores USING btree (config_id);


--
-- Name: scores_created_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX scores_created_at_idx ON public.scores USING btree (created_at);


--
-- Name: scores_id_project_id_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX scores_id_project_id_key ON public.scores USING btree (id, project_id);


--
-- Name: scores_observation_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX scores_observation_id_idx ON public.scores USING hash (observation_id);


--
-- Name: scores_project_id_name_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX scores_project_id_name_idx ON public.scores USING btree (project_id, name);


--
-- Name: scores_source_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX scores_source_idx ON public.scores USING btree (source);


--
-- Name: scores_timestamp_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX scores_timestamp_idx ON public.scores USING btree ("timestamp");


--
-- Name: scores_trace_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX scores_trace_id_idx ON public.scores USING hash (trace_id);


--
-- Name: scores_value_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX scores_value_idx ON public.scores USING btree (value);


--
-- Name: trace_media_project_id_trace_id_media_id_field_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX trace_media_project_id_trace_id_media_id_field_key ON public.trace_media USING btree (project_id, trace_id, media_id, field);


--
-- Name: trace_sessions_created_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX trace_sessions_created_at_idx ON public.trace_sessions USING btree (created_at);


--
-- Name: trace_sessions_project_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX trace_sessions_project_id_idx ON public.trace_sessions USING btree (project_id);


--
-- Name: trace_sessions_updated_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX trace_sessions_updated_at_idx ON public.trace_sessions USING btree (updated_at);


--
-- Name: traces_created_at_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX traces_created_at_idx ON public.traces USING btree (created_at);


--
-- Name: traces_id_user_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX traces_id_user_id_idx ON public.traces USING btree (id, user_id);


--
-- Name: traces_name_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX traces_name_idx ON public.traces USING btree (name);


--
-- Name: traces_project_id_timestamp_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX traces_project_id_timestamp_idx ON public.traces USING btree (project_id, "timestamp");


--
-- Name: traces_session_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX traces_session_id_idx ON public.traces USING btree (session_id);


--
-- Name: traces_tags_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX traces_tags_idx ON public.traces USING gin (tags);


--
-- Name: traces_timestamp_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX traces_timestamp_idx ON public.traces USING btree ("timestamp");


--
-- Name: traces_user_id_idx; Type: INDEX; Schema: public; Owner: squads
--

CREATE INDEX traces_user_id_idx ON public.traces USING btree (user_id);


--
-- Name: users_email_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX users_email_key ON public.users USING btree (email);


--
-- Name: verification_tokens_identifier_token_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX verification_tokens_identifier_token_key ON public.verification_tokens USING btree (identifier, token);


--
-- Name: verification_tokens_token_key; Type: INDEX; Schema: public; Owner: squads
--

CREATE UNIQUE INDEX verification_tokens_token_key ON public.verification_tokens USING btree (token);


--
-- Name: Account Account_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public."Account"
    ADD CONSTRAINT "Account_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: Session Session_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public."Session"
    ADD CONSTRAINT "Session_user_id_fkey" FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: annotation_queue_items annotation_queue_items_annotator_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.annotation_queue_items
    ADD CONSTRAINT annotation_queue_items_annotator_user_id_fkey FOREIGN KEY (annotator_user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: annotation_queue_items annotation_queue_items_locked_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.annotation_queue_items
    ADD CONSTRAINT annotation_queue_items_locked_by_user_id_fkey FOREIGN KEY (locked_by_user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: annotation_queue_items annotation_queue_items_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.annotation_queue_items
    ADD CONSTRAINT annotation_queue_items_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: annotation_queue_items annotation_queue_items_queue_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.annotation_queue_items
    ADD CONSTRAINT annotation_queue_items_queue_id_fkey FOREIGN KEY (queue_id) REFERENCES public.annotation_queues(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: annotation_queues annotation_queues_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.annotation_queues
    ADD CONSTRAINT annotation_queues_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: api_keys api_keys_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.api_keys
    ADD CONSTRAINT api_keys_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: batch_exports batch_exports_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.batch_exports
    ADD CONSTRAINT batch_exports_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: comments comments_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.comments
    ADD CONSTRAINT comments_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: dataset_items dataset_items_dataset_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.dataset_items
    ADD CONSTRAINT dataset_items_dataset_id_project_id_fkey FOREIGN KEY (dataset_id, project_id) REFERENCES public.datasets(id, project_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: dataset_run_items dataset_run_items_dataset_item_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.dataset_run_items
    ADD CONSTRAINT dataset_run_items_dataset_item_id_project_id_fkey FOREIGN KEY (dataset_item_id, project_id) REFERENCES public.dataset_items(id, project_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: dataset_run_items dataset_run_items_dataset_run_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.dataset_run_items
    ADD CONSTRAINT dataset_run_items_dataset_run_id_project_id_fkey FOREIGN KEY (dataset_run_id, project_id) REFERENCES public.dataset_runs(id, project_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: dataset_runs dataset_runs_dataset_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.dataset_runs
    ADD CONSTRAINT dataset_runs_dataset_id_project_id_fkey FOREIGN KEY (dataset_id, project_id) REFERENCES public.datasets(id, project_id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: datasets datasets_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.datasets
    ADD CONSTRAINT datasets_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: eval_templates eval_templates_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.eval_templates
    ADD CONSTRAINT eval_templates_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: events events_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.events
    ADD CONSTRAINT events_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: job_configurations job_configurations_eval_template_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.job_configurations
    ADD CONSTRAINT job_configurations_eval_template_id_fkey FOREIGN KEY (eval_template_id) REFERENCES public.eval_templates(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: job_configurations job_configurations_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.job_configurations
    ADD CONSTRAINT job_configurations_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: job_executions job_executions_job_configuration_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.job_executions
    ADD CONSTRAINT job_executions_job_configuration_id_fkey FOREIGN KEY (job_configuration_id) REFERENCES public.job_configurations(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: job_executions job_executions_job_output_score_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.job_executions
    ADD CONSTRAINT job_executions_job_output_score_id_fkey FOREIGN KEY (job_output_score_id) REFERENCES public.scores(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: job_executions job_executions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.job_executions
    ADD CONSTRAINT job_executions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: llm_api_keys llm_api_keys_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.llm_api_keys
    ADD CONSTRAINT llm_api_keys_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: media media_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.media
    ADD CONSTRAINT media_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: membership_invitations membership_invitations_invited_by_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.membership_invitations
    ADD CONSTRAINT membership_invitations_invited_by_user_id_fkey FOREIGN KEY (invited_by_user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: membership_invitations membership_invitations_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.membership_invitations
    ADD CONSTRAINT membership_invitations_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: membership_invitations membership_invitations_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.membership_invitations
    ADD CONSTRAINT membership_invitations_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: models models_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.models
    ADD CONSTRAINT models_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: observation_media observation_media_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.observation_media
    ADD CONSTRAINT observation_media_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: observation_media observation_media_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.observation_media
    ADD CONSTRAINT observation_media_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: observations observations_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.observations
    ADD CONSTRAINT observations_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: organization_memberships organization_memberships_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.organization_memberships
    ADD CONSTRAINT organization_memberships_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: organization_memberships organization_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.organization_memberships
    ADD CONSTRAINT organization_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: posthog_integrations posthog_integrations_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.posthog_integrations
    ADD CONSTRAINT posthog_integrations_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: prices prices_model_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.prices
    ADD CONSTRAINT prices_model_id_fkey FOREIGN KEY (model_id) REFERENCES public.models(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: project_memberships project_memberships_org_membership_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.project_memberships
    ADD CONSTRAINT project_memberships_org_membership_id_fkey FOREIGN KEY (org_membership_id) REFERENCES public.organization_memberships(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: project_memberships project_memberships_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.project_memberships
    ADD CONSTRAINT project_memberships_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: project_memberships project_memberships_user_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.project_memberships
    ADD CONSTRAINT project_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES public.users(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: projects projects_org_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.projects
    ADD CONSTRAINT projects_org_id_fkey FOREIGN KEY (org_id) REFERENCES public.organizations(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: prompts prompts_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.prompts
    ADD CONSTRAINT prompts_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: score_configs score_configs_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.score_configs
    ADD CONSTRAINT score_configs_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: scores scores_config_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.scores
    ADD CONSTRAINT scores_config_id_fkey FOREIGN KEY (config_id) REFERENCES public.score_configs(id) ON UPDATE CASCADE ON DELETE SET NULL;


--
-- Name: scores scores_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.scores
    ADD CONSTRAINT scores_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: trace_media trace_media_media_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.trace_media
    ADD CONSTRAINT trace_media_media_id_fkey FOREIGN KEY (media_id) REFERENCES public.media(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: trace_media trace_media_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.trace_media
    ADD CONSTRAINT trace_media_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: trace_sessions trace_sessions_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.trace_sessions
    ADD CONSTRAINT trace_sessions_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: traces traces_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.traces
    ADD CONSTRAINT traces_project_id_fkey FOREIGN KEY (project_id) REFERENCES public.projects(id) ON UPDATE CASCADE ON DELETE CASCADE;


--
-- Name: traces traces_session_id_project_id_fkey; Type: FK CONSTRAINT; Schema: public; Owner: squads
--

ALTER TABLE ONLY public.traces
    ADD CONSTRAINT traces_session_id_project_id_fkey FOREIGN KEY (session_id, project_id) REFERENCES public.trace_sessions(id, project_id) ON UPDATE CASCADE ON DELETE RESTRICT;


--
-- PostgreSQL database dump complete
--

\unrestrict dbqJrS9dCgqQa9recDJhrdJA0aTPFZxvWVxcf4zHj6cabOTqrzVLK8LEOEvS7m9

--
-- Database "postgres" dump
--

\connect postgres

--
-- PostgreSQL database dump
--

\restrict e2Hchx0XjcBm19erXH4Oh0Hq7VC7MKFw6O6UcoGIhccyELATubfNLvF8fXsawYE

-- Dumped from database version 16.11
-- Dumped by pg_dump version 16.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- PostgreSQL database dump complete
--

\unrestrict e2Hchx0XjcBm19erXH4Oh0Hq7VC7MKFw6O6UcoGIhccyELATubfNLvF8fXsawYE

--
-- Database "squads" dump
--

--
-- PostgreSQL database dump
--

\restrict LJ8zvYQOdQRWTfhhFezeDOuvCpa5ZubtIxBf3dfTnDvCcMT1F1uG89eCEQvwzgL

-- Dumped from database version 16.11
-- Dumped by pg_dump version 16.11

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: squads; Type: DATABASE; Schema: -; Owner: squads
--

CREATE DATABASE squads WITH TEMPLATE = template0 ENCODING = 'UTF8' LOCALE_PROVIDER = libc LOCALE = 'en_US.utf8';


ALTER DATABASE squads OWNER TO squads;

\unrestrict LJ8zvYQOdQRWTfhhFezeDOuvCpa5ZubtIxBf3dfTnDvCcMT1F1uG89eCEQvwzgL
\connect squads
\restrict LJ8zvYQOdQRWTfhhFezeDOuvCpa5ZubtIxBf3dfTnDvCcMT1F1uG89eCEQvwzgL

SET statement_timeout = 0;
SET lock_timeout = 0;
SET idle_in_transaction_session_timeout = 0;
SET client_encoding = 'UTF8';
SET standard_conforming_strings = on;
SELECT pg_catalog.set_config('search_path', '', false);
SET check_function_bodies = false;
SET xmloption = content;
SET client_min_messages = warning;
SET row_security = off;

--
-- Name: squads; Type: SCHEMA; Schema: -; Owner: squads
--

CREATE SCHEMA squads;


ALTER SCHEMA squads OWNER TO squads;

SET default_tablespace = '';

SET default_table_access_method = heap;

--
-- Name: agent_executions; Type: TABLE; Schema: squads; Owner: squads
--

CREATE TABLE squads.agent_executions (
    id integer NOT NULL,
    squad character varying(100) NOT NULL,
    agent character varying(100) NOT NULL,
    execution_id character varying(255),
    started_at timestamp with time zone NOT NULL,
    completed_at timestamp with time zone,
    duration_ms integer,
    status character varying(50) DEFAULT 'running'::character varying,
    output_type character varying(50),
    output_ref character varying(255),
    input_tokens integer DEFAULT 0,
    output_tokens integer DEFAULT 0,
    cost_usd numeric(10,6) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE squads.agent_executions OWNER TO squads;

--
-- Name: agent_executions_id_seq; Type: SEQUENCE; Schema: squads; Owner: squads
--

CREATE SEQUENCE squads.agent_executions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE squads.agent_executions_id_seq OWNER TO squads;

--
-- Name: agent_executions_id_seq; Type: SEQUENCE OWNED BY; Schema: squads; Owner: squads
--

ALTER SEQUENCE squads.agent_executions_id_seq OWNED BY squads.agent_executions.id;


--
-- Name: agent_insights; Type: TABLE; Schema: squads; Owner: squads
--

CREATE TABLE squads.agent_insights (
    id integer NOT NULL,
    captured_at timestamp with time zone DEFAULT now(),
    period character varying(20) NOT NULL,
    period_start date NOT NULL,
    squad character varying(100) NOT NULL,
    agent character varying(100),
    tasks_started integer DEFAULT 0,
    tasks_completed integer DEFAULT 0,
    tasks_failed integer DEFAULT 0,
    success_rate numeric(5,2),
    total_retries integer DEFAULT 0,
    avg_retries_per_task numeric(5,2),
    tasks_with_retries integer DEFAULT 0,
    avg_quality_score numeric(3,2),
    feedback_count integer DEFAULT 0,
    helpful_pct numeric(5,2),
    fix_required_pct numeric(5,2),
    avg_duration_ms integer,
    avg_tokens_per_task integer,
    avg_cost_per_task numeric(10,6),
    avg_context_utilization numeric(5,2),
    top_tools jsonb DEFAULT '[]'::jsonb,
    tool_failure_rate numeric(5,2)
);


ALTER TABLE squads.agent_insights OWNER TO squads;

--
-- Name: agent_insights_id_seq; Type: SEQUENCE; Schema: squads; Owner: squads
--

CREATE SEQUENCE squads.agent_insights_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE squads.agent_insights_id_seq OWNER TO squads;

--
-- Name: agent_insights_id_seq; Type: SEQUENCE OWNED BY; Schema: squads; Owner: squads
--

ALTER SEQUENCE squads.agent_insights_id_seq OWNED BY squads.agent_insights.id;


--
-- Name: baselines; Type: TABLE; Schema: squads; Owner: squads
--

CREATE TABLE squads.baselines (
    id integer NOT NULL,
    org character varying(255) NOT NULL,
    name character varying(100) NOT NULL,
    captured_at timestamp with time zone DEFAULT now(),
    commits_30d integer DEFAULT 0,
    prs_30d integer DEFAULT 0,
    issues_30d integer DEFAULT 0,
    avg_pr_cycle_hours numeric(10,2),
    notes text
);


ALTER TABLE squads.baselines OWNER TO squads;

--
-- Name: baselines_id_seq; Type: SEQUENCE; Schema: squads; Owner: squads
--

CREATE SEQUENCE squads.baselines_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE squads.baselines_id_seq OWNER TO squads;

--
-- Name: baselines_id_seq; Type: SEQUENCE OWNED BY; Schema: squads; Owner: squads
--

ALTER SEQUENCE squads.baselines_id_seq OWNED BY squads.baselines.id;


--
-- Name: cli_events; Type: TABLE; Schema: squads; Owner: squads
--

CREATE TABLE squads.cli_events (
    id integer NOT NULL,
    received_at timestamp with time zone DEFAULT now(),
    anonymous_id character varying(100),
    event_name character varying(100) NOT NULL,
    cli_version character varying(20),
    properties jsonb DEFAULT '{}'::jsonb
);


ALTER TABLE squads.cli_events OWNER TO squads;

--
-- Name: cli_events_id_seq; Type: SEQUENCE; Schema: squads; Owner: squads
--

CREATE SEQUENCE squads.cli_events_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE squads.cli_events_id_seq OWNER TO squads;

--
-- Name: cli_events_id_seq; Type: SEQUENCE OWNED BY; Schema: squads; Owner: squads
--

ALTER SEQUENCE squads.cli_events_id_seq OWNED BY squads.cli_events.id;


--
-- Name: conversations; Type: TABLE; Schema: squads; Owner: squads
--

CREATE TABLE squads.conversations (
    id integer NOT NULL,
    session_id character varying(255),
    user_id character varying(255) DEFAULT 'local'::character varying,
    role character varying(50) NOT NULL,
    content text NOT NULL,
    message_type character varying(50) DEFAULT 'message'::character varying,
    importance character varying(20) DEFAULT 'normal'::character varying,
    squad character varying(100),
    agent character varying(100),
    working_dir character varying(500),
    created_at timestamp with time zone DEFAULT now(),
    metadata jsonb DEFAULT '{}'::jsonb
);


ALTER TABLE squads.conversations OWNER TO squads;

--
-- Name: conversations_id_seq; Type: SEQUENCE; Schema: squads; Owner: squads
--

CREATE SEQUENCE squads.conversations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE squads.conversations_id_seq OWNER TO squads;

--
-- Name: conversations_id_seq; Type: SEQUENCE OWNED BY; Schema: squads; Owner: squads
--

ALTER SEQUENCE squads.conversations_id_seq OWNED BY squads.conversations.id;


--
-- Name: dashboard_snapshots; Type: TABLE; Schema: squads; Owner: squads
--

CREATE TABLE squads.dashboard_snapshots (
    id integer NOT NULL,
    captured_at timestamp with time zone DEFAULT now(),
    total_squads integer DEFAULT 0,
    total_commits integer DEFAULT 0,
    total_prs_merged integer DEFAULT 0,
    total_issues_closed integer DEFAULT 0,
    total_issues_open integer DEFAULT 0,
    goal_progress_pct integer DEFAULT 0,
    cost_usd numeric(10,4) DEFAULT 0,
    daily_budget_usd numeric(10,2) DEFAULT 50,
    input_tokens integer DEFAULT 0,
    output_tokens integer DEFAULT 0,
    commits_30d integer DEFAULT 0,
    avg_commits_per_day numeric(5,1) DEFAULT 0,
    active_days integer DEFAULT 0,
    peak_commits integer DEFAULT 0,
    peak_date date,
    squads_data jsonb DEFAULT '[]'::jsonb,
    authors_data jsonb DEFAULT '[]'::jsonb,
    repos_data jsonb DEFAULT '[]'::jsonb
);


ALTER TABLE squads.dashboard_snapshots OWNER TO squads;

--
-- Name: dashboard_snapshots_id_seq; Type: SEQUENCE; Schema: squads; Owner: squads
--

CREATE SEQUENCE squads.dashboard_snapshots_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE squads.dashboard_snapshots_id_seq OWNER TO squads;

--
-- Name: dashboard_snapshots_id_seq; Type: SEQUENCE OWNED BY; Schema: squads; Owner: squads
--

ALTER SEQUENCE squads.dashboard_snapshots_id_seq OWNED BY squads.dashboard_snapshots.id;


--
-- Name: github_metrics; Type: TABLE; Schema: squads; Owner: squads
--

CREATE TABLE squads.github_metrics (
    id integer NOT NULL,
    org character varying(255) NOT NULL,
    repo character varying(255) NOT NULL,
    metric_date date NOT NULL,
    commits integer DEFAULT 0,
    prs_opened integer DEFAULT 0,
    prs_merged integer DEFAULT 0,
    prs_closed integer DEFAULT 0,
    issues_opened integer DEFAULT 0,
    issues_closed integer DEFAULT 0,
    reviews integer DEFAULT 0,
    additions integer DEFAULT 0,
    deletions integer DEFAULT 0,
    avg_pr_cycle_hours numeric(10,2),
    review_pass_rate numeric(5,2),
    created_at timestamp with time zone DEFAULT now()
);


ALTER TABLE squads.github_metrics OWNER TO squads;

--
-- Name: github_metrics_id_seq; Type: SEQUENCE; Schema: squads; Owner: squads
--

CREATE SEQUENCE squads.github_metrics_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE squads.github_metrics_id_seq OWNER TO squads;

--
-- Name: github_metrics_id_seq; Type: SEQUENCE OWNED BY; Schema: squads; Owner: squads
--

ALTER SEQUENCE squads.github_metrics_id_seq OWNED BY squads.github_metrics.id;


--
-- Name: llm_generations; Type: TABLE; Schema: squads; Owner: squads
--

CREATE TABLE squads.llm_generations (
    id integer NOT NULL,
    session_id character varying(255) NOT NULL,
    trace_id character varying(255),
    squad character varying(100) DEFAULT 'hq'::character varying,
    agent character varying(100) DEFAULT 'coo'::character varying,
    user_id character varying(255),
    model character varying(100) NOT NULL,
    input_tokens integer DEFAULT 0,
    output_tokens integer DEFAULT 0,
    cache_read_tokens integer DEFAULT 0,
    cache_creation_tokens integer DEFAULT 0,
    cost_usd numeric(10,6) DEFAULT 0,
    created_at timestamp with time zone DEFAULT now(),
    duration_ms integer,
    metadata jsonb DEFAULT '{}'::jsonb
);


ALTER TABLE squads.llm_generations OWNER TO squads;

--
-- Name: llm_generations_id_seq; Type: SEQUENCE; Schema: squads; Owner: squads
--

CREATE SEQUENCE squads.llm_generations_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE squads.llm_generations_id_seq OWNER TO squads;

--
-- Name: llm_generations_id_seq; Type: SEQUENCE OWNED BY; Schema: squads; Owner: squads
--

ALTER SEQUENCE squads.llm_generations_id_seq OWNED BY squads.llm_generations.id;


--
-- Name: sessions; Type: TABLE; Schema: squads; Owner: squads
--

CREATE TABLE squads.sessions (
    id character varying(255) NOT NULL,
    squad character varying(100) DEFAULT 'hq'::character varying,
    agent character varying(100) DEFAULT 'coo'::character varying,
    user_id character varying(255),
    total_input_tokens integer DEFAULT 0,
    total_output_tokens integer DEFAULT 0,
    total_cost_usd numeric(10,6) DEFAULT 0,
    generation_count integer DEFAULT 0,
    tool_count integer DEFAULT 0,
    started_at timestamp with time zone DEFAULT now(),
    last_activity_at timestamp with time zone DEFAULT now(),
    status character varying(50) DEFAULT 'active'::character varying
);


ALTER TABLE squads.sessions OWNER TO squads;

--
-- Name: task_feedback; Type: TABLE; Schema: squads; Owner: squads
--

CREATE TABLE squads.task_feedback (
    id integer NOT NULL,
    task_id character varying(255),
    quality_score integer,
    was_helpful boolean,
    required_fixes boolean DEFAULT false,
    fix_description text,
    tags character varying(50)[],
    created_at timestamp with time zone DEFAULT now(),
    notes text,
    CONSTRAINT task_feedback_quality_score_check CHECK (((quality_score >= 1) AND (quality_score <= 5)))
);


ALTER TABLE squads.task_feedback OWNER TO squads;

--
-- Name: task_feedback_id_seq; Type: SEQUENCE; Schema: squads; Owner: squads
--

CREATE SEQUENCE squads.task_feedback_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE squads.task_feedback_id_seq OWNER TO squads;

--
-- Name: task_feedback_id_seq; Type: SEQUENCE OWNED BY; Schema: squads; Owner: squads
--

ALTER SEQUENCE squads.task_feedback_id_seq OWNED BY squads.task_feedback.id;


--
-- Name: tasks; Type: TABLE; Schema: squads; Owner: squads
--

CREATE TABLE squads.tasks (
    id integer NOT NULL,
    task_id character varying(255) NOT NULL,
    session_id character varying(255),
    squad character varying(100) NOT NULL,
    agent character varying(100),
    task_type character varying(50) DEFAULT 'goal'::character varying,
    description text,
    status character varying(50) DEFAULT 'started'::character varying,
    success boolean,
    retry_count integer DEFAULT 0,
    output_type character varying(50),
    output_ref character varying(500),
    total_tokens integer DEFAULT 0,
    total_cost_usd numeric(10,6) DEFAULT 0,
    peak_context_tokens integer DEFAULT 0,
    context_utilization_pct numeric(5,2),
    started_at timestamp with time zone DEFAULT now(),
    completed_at timestamp with time zone,
    duration_ms integer,
    metadata jsonb DEFAULT '{}'::jsonb
);


ALTER TABLE squads.tasks OWNER TO squads;

--
-- Name: tasks_id_seq; Type: SEQUENCE; Schema: squads; Owner: squads
--

CREATE SEQUENCE squads.tasks_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE squads.tasks_id_seq OWNER TO squads;

--
-- Name: tasks_id_seq; Type: SEQUENCE OWNED BY; Schema: squads; Owner: squads
--

ALTER SEQUENCE squads.tasks_id_seq OWNED BY squads.tasks.id;


--
-- Name: tool_executions; Type: TABLE; Schema: squads; Owner: squads
--

CREATE TABLE squads.tool_executions (
    id integer NOT NULL,
    session_id character varying(255) NOT NULL,
    trace_id character varying(255),
    squad character varying(100) DEFAULT 'hq'::character varying,
    agent character varying(100) DEFAULT 'coo'::character varying,
    tool_name character varying(255) NOT NULL,
    success boolean DEFAULT true,
    created_at timestamp with time zone DEFAULT now(),
    duration_ms integer,
    metadata jsonb DEFAULT '{}'::jsonb
);


ALTER TABLE squads.tool_executions OWNER TO squads;

--
-- Name: tool_executions_id_seq; Type: SEQUENCE; Schema: squads; Owner: squads
--

CREATE SEQUENCE squads.tool_executions_id_seq
    AS integer
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;


ALTER SEQUENCE squads.tool_executions_id_seq OWNER TO squads;

--
-- Name: tool_executions_id_seq; Type: SEQUENCE OWNED BY; Schema: squads; Owner: squads
--

ALTER SEQUENCE squads.tool_executions_id_seq OWNED BY squads.tool_executions.id;


--
-- Name: agent_executions id; Type: DEFAULT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.agent_executions ALTER COLUMN id SET DEFAULT nextval('squads.agent_executions_id_seq'::regclass);


--
-- Name: agent_insights id; Type: DEFAULT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.agent_insights ALTER COLUMN id SET DEFAULT nextval('squads.agent_insights_id_seq'::regclass);


--
-- Name: baselines id; Type: DEFAULT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.baselines ALTER COLUMN id SET DEFAULT nextval('squads.baselines_id_seq'::regclass);


--
-- Name: cli_events id; Type: DEFAULT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.cli_events ALTER COLUMN id SET DEFAULT nextval('squads.cli_events_id_seq'::regclass);


--
-- Name: conversations id; Type: DEFAULT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.conversations ALTER COLUMN id SET DEFAULT nextval('squads.conversations_id_seq'::regclass);


--
-- Name: dashboard_snapshots id; Type: DEFAULT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.dashboard_snapshots ALTER COLUMN id SET DEFAULT nextval('squads.dashboard_snapshots_id_seq'::regclass);


--
-- Name: github_metrics id; Type: DEFAULT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.github_metrics ALTER COLUMN id SET DEFAULT nextval('squads.github_metrics_id_seq'::regclass);


--
-- Name: llm_generations id; Type: DEFAULT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.llm_generations ALTER COLUMN id SET DEFAULT nextval('squads.llm_generations_id_seq'::regclass);


--
-- Name: task_feedback id; Type: DEFAULT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.task_feedback ALTER COLUMN id SET DEFAULT nextval('squads.task_feedback_id_seq'::regclass);


--
-- Name: tasks id; Type: DEFAULT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.tasks ALTER COLUMN id SET DEFAULT nextval('squads.tasks_id_seq'::regclass);


--
-- Name: tool_executions id; Type: DEFAULT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.tool_executions ALTER COLUMN id SET DEFAULT nextval('squads.tool_executions_id_seq'::regclass);


--
-- Data for Name: agent_executions; Type: TABLE DATA; Schema: squads; Owner: squads
--

COPY squads.agent_executions (id, squad, agent, execution_id, started_at, completed_at, duration_ms, status, output_type, output_ref, input_tokens, output_tokens, cost_usd, created_at) FROM stdin;
\.


--
-- Data for Name: agent_insights; Type: TABLE DATA; Schema: squads; Owner: squads
--

COPY squads.agent_insights (id, captured_at, period, period_start, squad, agent, tasks_started, tasks_completed, tasks_failed, success_rate, total_retries, avg_retries_per_task, tasks_with_retries, avg_quality_score, feedback_count, helpful_pct, fix_required_pct, avg_duration_ms, avg_tokens_per_task, avg_cost_per_task, avg_context_utilization, top_tools, tool_failure_rate) FROM stdin;
\.


--
-- Data for Name: baselines; Type: TABLE DATA; Schema: squads; Owner: squads
--

COPY squads.baselines (id, org, name, captured_at, commits_30d, prs_30d, issues_30d, avg_pr_cycle_hours, notes) FROM stdin;
\.


--
-- Data for Name: cli_events; Type: TABLE DATA; Schema: squads; Owner: squads
--

COPY squads.cli_events (id, received_at, anonymous_id, event_name, cli_version, properties) FROM stdin;
\.


--
-- Data for Name: conversations; Type: TABLE DATA; Schema: squads; Owner: squads
--

COPY squads.conversations (id, session_id, user_id, role, content, message_type, importance, squad, agent, working_dir, created_at, metadata) FROM stdin;
1	bc488ee3-38ec-41a2-9df0-1af7065105f0	local	assistant	All containers now under **`agents-squads`** project. Docker Desktop will show them in one group:\n\n```\nagents-squads/\n  ├── squads-postgres     (healthy)\n  ├── squads-redis        (healthy)\n  ├── squads-bridge       (up)\n  ├── squads-langfuse     (starting)\n  └── squads-otel-collector (up)\n```\n\nThe issue before was mixed project names (`agents-squads` vs `docker`). Fixed by recreating all via `docker-compose up -d` from the correct directory.	message	normal	\N	\N	\N	2026-01-04 12:32:21.50604+00	{"source": "hook:Stop", "timestamp": "2026-01-04T09:32:21.426024", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
2	session-1767529941	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: c5bb5d3 chore(memory): Close telemetry issue #9 - pipeline fully operational\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 12:32:21.586705+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T12:32:21Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 11}
3	f7e23c60-fddf-4587-adc2-1f9009c01028	local	user	let's care about the product, the leads will come, plus, you don't stil see it because you haven't set up x.com credentials, but lot of people is sharing similar developments on it. we can't contact someone with just this	message	normal	\N	\N	\N	2026-01-04 12:33:13.232219+00	{"source": "hook:UserPromptSubmit", "timestamp": "2026-01-04T09:33:13.210886", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
4	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	local	assistant	Fixed. The price changed from $20 to $29 but the test wasn't updated.\n\n**Watch the new CI run:**\nhttps://github.com/agents-squads/agents-squads-web/actions\n\nThe E2E issue was:\n1. ✅ Vercel link/server - **Fixed** (now passing)\n2. ✅ Price test - **Fixed** ($20 → $29)\n\nShould pass now.	message	normal	\N	\N	\N	2026-01-04 12:33:14.849314+00	{"source": "hook:Stop", "timestamp": "2026-01-04T09:33:14.753891", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
5	session-1767529994	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: c5bb5d3 chore(memory): Close telemetry issue #9 - pipeline fully operational\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 12:33:14.931977+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T12:33:14Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 11}
6	f7e23c60-fddf-4587-adc2-1f9009c01028	local	assistant	Good call. Product first, outreach later.\n\n**Product priorities:**\n\n1. **CLI** (core product, needs polish before npm publish)\n   - Test infrastructure (#9-10)\n   - Refactor dashboardCommand (#4)\n   - Type fixes (#2, #6)\n   - Templates for common use cases (#11)\n   - Memory search filters (#12)\n\n2. **Website** (credibility layer)\n   - SEO fixes (#180-183)\n   - Missing meta tags\n\n3. **Docs** (docs.agents-squads.com)\n   - Already live on Mintlify\n\nWant me to tackle the CLI issues? That's the product people will actually use and share.	message	normal	\N	\N	\N	2026-01-04 12:33:24.256623+00	{"source": "hook:Stop", "timestamp": "2026-01-04T09:33:24.238838", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
7	session-1767530004	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: c5bb5d3 chore(memory): Close telemetry issue #9 - pipeline fully operational\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 12:33:24.361864+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T12:33:24Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 11}
8	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	local	user	https://github.com/agents-squads/agents-squads-web/pull/177 this did not pass and has conflic	message	normal	\N	\N	\N	2026-01-04 12:34:06.193853+00	{"source": "hook:UserPromptSubmit", "timestamp": "2026-01-04T09:34:06.173944", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
9	f7e23c60-fddf-4587-adc2-1f9009c01028	local	user	I'm checking in other terminal session, help me setup a way for you to get updates from x 	message	normal	\N	\N	\N	2026-01-04 12:35:09.466418+00	{"source": "hook:UserPromptSubmit", "timestamp": "2026-01-04T09:35:09.445456", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
10	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	local	assistant	Both PRs rebased and pushed:\n\n**Watch CI:**\n- PR #177: https://github.com/agents-squads/agents-squads-web/pull/177\n- PR #178: https://github.com/agents-squads/agents-squads-web/pull/178\n\nThey should pass now - both have the latest CI fixes and test updates.	message	normal	\N	\N	\N	2026-01-04 12:35:17.974742+00	{"source": "hook:Stop", "timestamp": "2026-01-04T09:35:17.888630", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
11	session-1767530117	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: c5bb5d3 chore(memory): Close telemetry issue #9 - pipeline fully operational\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 12:35:18.071614+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T12:35:18Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 11}
12	bc488ee3-38ec-41a2-9df0-1af7065105f0	local	user	great! now we're talking! env file and squads init are enought to connect everything ? the cli with the local stack? 	message	normal	\N	\N	\N	2026-01-04 12:36:05.858296+00	{"source": "hook:UserPromptSubmit", "timestamp": "2026-01-04T09:36:05.837047", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
32	a811cf52-5a86-40d1-8f75-63f7599eb286	local	user	search X for 'claude code agents'	message	normal	\N	\N	\N	2026-01-04 12:59:02.182375+00	{"source": "hook:UserPromptSubmit", "timestamp": "2026-01-04T09:59:02.163773", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
33	bc488ee3-38ec-41a2-9df0-1af7065105f0	local	assistant	Done! Here's what was accomplished:\n\n**Stack commands implemented** (`squads stack`):\n- `init` - Auto-detects Docker, tests connections, saves `~/.squadsrc`\n- `status` - Shows container health in formatted table\n- `env` - Prints export commands for shell\n- `up` / `down` - Start/stop docker-compose stack\n\n**Goals updated** (6 marked complete):\n- `engineering[1]` - Fix Langfuse telemetry ✓\n- `cli[1]` - Complete telemetry pipeline ✓\n- `marketing[1]` - Establish baseline metrics ✓\n- `marketing[2]` - Set up tracking infrastructure ✓\n- `marketing[11]` - Technical SEO ✓\n- `finance[1]` - Track costs via Langfuse ✓\n\n**Active goals remaining**: 17 (down from 23)	message	normal	\N	\N	\N	2026-01-04 13:00:32.379907+00	{"source": "hook:Stop", "timestamp": "2026-01-04T10:00:32.358833", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
13	bc488ee3-38ec-41a2-9df0-1af7065105f0	local	assistant	Not quite. There's a gap:\n\n## Current State\n\n| Component | Env Var | Default | Source |\n|-----------|---------|---------|--------|\n| Bridge | `SQUADS_BRIDGE_URL` | `localhost:8088` | ✅ Works |\n| Postgres | `SQUADS_DATABASE_URL` | None | ❌ Must set |\n| Langfuse | `LANGFUSE_HOST` | cloud.langfuse.com | ❌ Points to cloud |\n| Langfuse | `LANGFUSE_PUBLIC_KEY` | None | ❌ Must set |\n| Langfuse | `LANGFUSE_SECRET_KEY` | None | ❌ Must set |\n| Redis | `REDIS_URL` | None | ❌ Must set |\n\n**`squads init`** only creates project structure (`.agents/squads/`), not connection config.\n\n## What's Missing\n\n```bash\nsquads stack init    # Detect local Docker, auto-configure\nsquads stack status  # Show connection health\nsquads stack env     # Print env vars to export\n```\n\n## Quick Fix Now\n\nYour shell needs these exports:\n\n```bash\nexport SQUADS_DATABASE_URL=postgresql://squads:squads@localhost:5433/squads\nexport SQUADS_BRIDGE_URL=http://localhost:8088\nexport LANGFUSE_HOST=http://localhost:3100\nexport LANGFUSE_PUBLIC_KEY=pk-lf-db01be25-6fa3-49ad-8b6b-31057e5598af\nexport LANGFUSE_SECRET_KEY=sk-lf-e2b08fb7-939a-4a1b-b481-9a20267a66e6\nexport REDIS_URL=redis://localhost:6379\n```\n\nWant me to:\n1. **Add `squads stack` commands** to auto-detect and configure?\n2. **Create a `.squadsrc`** file the CLI auto-loads?\n3. **Add to `squads init`** to optionally set up local stack?	message	normal	\N	\N	\N	2026-01-04 12:36:33.541584+00	{"source": "hook:Stop", "timestamp": "2026-01-04T09:36:33.519640", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
14	session-1767530193	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: c5bb5d3 chore(memory): Close telemetry issue #9 - pipeline fully operational\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 12:36:33.647915+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T12:36:33Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 11}
15	f7e23c60-fddf-4587-adc2-1f9009c01028	local	assistant	Found several X MCP servers:\n\n**Easiest options:**\n\n| MCP Server | Auth Method | Install |\n|------------|-------------|---------|\n| [twitter-mcp](https://github.com/EnesCinr/twitter-mcp) | X API keys | `npx @enescinar/twitter-mcp` |\n| [x-mcp](https://github.com/lord-dubious/x-mcp) | Twikit (cookies) | Python, no API needed |\n| [mcp-twitter-server](https://github.com/crazyrabbitltc/mcp-twitter-server) | X API keys | npm |\n\n**Recommended: x-mcp (no API keys needed)**\n\nUses Twikit which authenticates via browser cookies - no developer account required.\n\n```bash\n# Clone and set up\ngit clone https://github.com/lord-dubious/x-mcp.git\ncd x-mcp\npip install -r requirements.txt\n\n# Add to Claude Code MCP config\n```\n\nWant me to set this up? Or if you have X API credentials already, the `twitter-mcp` npm package is simpler.\n\nSources:\n- [twitter-mcp](https://github.com/EnesCinr/twitter-mcp)\n- [x-mcp](https://github.com/lord-dubious/x-mcp)\n- [mcp-twitter-server](https://github.com/crazyrabbitltc/mcp-twitter-server)	message	normal	\N	\N	\N	2026-01-04 12:36:53.653091+00	{"source": "hook:Stop", "timestamp": "2026-01-04T09:36:53.557830", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
16	session-1767530213	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: c5bb5d3 chore(memory): Close telemetry issue #9 - pipeline fully operational\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 12:36:53.736427+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T12:36:53Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 11}
17	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	local	user	evaluate the agents-squads repo and with our hq implementation	message	normal	\N	\N	\N	2026-01-04 12:38:23.261858+00	{"source": "hook:UserPromptSubmit", "timestamp": "2026-01-04T09:38:23.242620", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
18	f7e23c60-fddf-4587-adc2-1f9009c01028	local	user	new var on the .env file\nX_CONSUMER_API_KEY=toUB10OfmaYgxydDH9wSIv4zb\nX_CONSUMER_API_SECRET=1XsUOAQglARAgpKI4rJ5hNAAbjLuVJd8rzt6lmakpcZaFWBl4o\nX_BEARER_TOKEN=AAAAAAAAAAAAAAAAAAAAAE0C6wEAAAAAnC8q6m2v9Gxk9wVbs7Mbx0TMjpU%3Db96xcKoCi0OcQ0fJCkSIHFbtrk9zFAwlMWsAky25rt3FQp8MbI\nX_API_KEY=56249352-PeIv15X3w8D8B0TEctHCMMwen9g5d2xIOs8DUvzVa\nX_API_SECRET=kHaKtlCJu2GlERp7V8Wvq2UqgAtCBxdg6zu57K1P1ffCS	message	normal	\N	\N	\N	2026-01-04 12:46:25.72163+00	{"source": "hook:UserPromptSubmit", "timestamp": "2026-01-04T09:46:25.700169", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
19	f7e23c60-fddf-4587-adc2-1f9009c01028	local	user	let's create our own mcp	message	normal	\N	\N	\N	2026-01-04 12:46:37.112715+00	{"source": "hook:UserPromptSubmit", "timestamp": "2026-01-04T09:46:37.091403", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
20	fd62c9dc-5784-4526-9dae-374db685bce0	local	assistant	Done. Created:\n\n## Engram Roadmap\n\n**File**: `engram/ROADMAP.md`\n\n| Version | Theme | Key Features |\n|---------|-------|--------------|\n| **v0.2.0** | Infrastructure Integration | Unified with squads-cli, shared postgres/neo4j/redis |\n| **v0.3.0** | Memory Intelligence | Entity extraction, relationship inference, dedup |\n| **v0.4.0** | Export/Import & Multi-Agent | JSON-LD export, squad-level sharing |\n| **v0.5.0** | Memory Lifecycle | Rolling summaries, conflict detection, retention |\n| **v1.0.0** | MemoryML | Full declarative memory modeling language |\n\n## GitHub Issues Created\n\n| Repo | Issue | Title |\n|------|-------|-------|\n| squads-cli | [#14](https://github.com/agents-squads/squads-cli/issues/14) | Integrate Engram into local infrastructure |\n| engram | [#3](https://github.com/agents-squads/engram/issues/3) | Update config for squads-cli infrastructure integration |\n\n## v0.2.0 Work Summary\n\n**squads-cli changes**:\n- Upgrade postgres to pgvector\n- Add mem0 + engram-mcp services\n- Make neo4j default (not profile: full)\n- Add `--lite` and `--no-memory` flags\n\n**engram changes**:\n- Update configs for squads-cli ports\n- Deprecate standalone docker-compose\n- Add health endpoint\n- Migration script for existing users\n\nWant me to start implementing v0.2.0 or work on CLI/template roadmaps next?	message	normal	\N	\N	\N	2026-01-04 12:48:43.691123+00	{"source": "hook:Stop", "timestamp": "2026-01-04T09:48:43.508731", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
21	session-1767530923	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: c5bb5d3 chore(memory): Close telemetry issue #9 - pipeline fully operational\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 12:48:43.861898+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T12:48:43Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 12}
22	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	local	user	tell me everything about our open issues and open PR by squads, I'll review them 	message	normal	\N	\N	\N	2026-01-04 12:49:36.865802+00	{"source": "hook:UserPromptSubmit", "timestamp": "2026-01-04T09:49:36.847132", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
23	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	local	assistant	## Open Issues & PRs by Squad\n\n### **HQ Repo** (14 open issues, 0 PRs)\n\n#### `squad:engineering` (P1-P2)\n| # | Title | Priority | Type |\n|---|-------|----------|------|\n| [31](https://github.com/agents-squads/hq/issues/31) | Add test coverage for critical components | **P1** | enhancement |\n| [32](https://github.com/agents-squads/hq/issues/32) | Expand CI/CD pipeline with automated deployments | P2 | enhancement |\n| [33](https://github.com/agents-squads/hq/issues/33) | Add environment variable validation and documentation | P2 | docs |\n| [34](https://github.com/agents-squads/hq/issues/34) | Improve error handling in Supabase Edge Functions | P2 | bug |\n\n#### Unlabeled (Code Quality / Infra)\n| # | Title | Type |\n|---|-------|------|\n| [25](https://github.com/agents-squads/hq/issues/25) | Add comprehensive test coverage for HQ repository | enhancement |\n| [26](https://github.com/agents-squads/hq/issues/26) | Add automated testing pipeline to GitHub Actions | enhancement |\n| [27](https://github.com/agents-squads/hq/issues/27) | Add API documentation for custom MCP servers | docs |\n| [28](https://github.com/agents-squads/hq/issues/28) | Add .env.example template for environment configuration | docs |\n| [29](https://github.com/agents-squads/hq/issues/29) | Consolidate Python dependency management across MCP servers | enhancement |\n| [30](https://github.com/agents-squads/hq/issues/30) | Add validation and error handling to remember.sh hook | enhancement |\n\n#### Compliance (No Squad Label)\n| # | Title |\n|---|-------|\n| [19](https://github.com/agents-squads/hq/issues/19) | SOC 2 Type II Certification |\n| [20](https://github.com/agents-squads/hq/issues/20) | GDPR Compliance |\n| [21](https://github.com/agents-squads/hq/issues/21) | ISO 27001 Certification |\n\n#### `squad:product`\n| # | Title |\n|---|-------|\n| [10](https://github.com/agents-squads/hq/issues/10) | CLI Research: Value proposition and feature roadmap |\n\n---\n\n### **Website Repo** (10 open issues, 0 PRs)\n\n#### `squad:website` - SEO\n| # | Title | Priority |\n|---|-------|----------|\n| [180](https://github.com/agents-squads/agents-squads-web/issues/180) | High: Optimize llms.txt format for AI agent discovery | P2 |\n| [181](https://github.com/agents-squads/agents-squads-web/issues/181) | Medium: Add missing meta tags for social sharing | - |\n| [182](https://github.com/agents-squads/agents-squads-web/issues/182) | Medium: Add SoftwareApplication schema for search results | - |\n| [183](https://github.com/agents-squads/agents-squads-web/issues/183) | Medium: Optimize H1 to include 'Agents Squads' brand keyword | - |\n\n#### `squad:website` - Analytics/Conversion\n| # | Title | Priority |\n|---|-------|----------|\n| [166](https://github.com/agents-squads/agents-squads-web/issues/166) | Implement onboarding_path_select tracking | P2 |\n| [167](https://github.com/agents-squads/agents-squads-web/issues/167) | Add scroll milestone tracking component | P2 |\n\n#### CI/CD & Testing\n| # | Title | Priority |\n|---|-------|----------|\n| [172](https://github.com/agents-squads/agents-squads-web/issues/172) | Add CI/CD pipeline with automated testing | **P1** |\n| [174](https://github.com/agents-squads/agents-squads-web/issues/174) | Add unit tests for API routes and Supabase functions | P2 |\n| [169](https://github.com/agents-squads/agents-squads-web/issues/169) | Expand E2E test coverage beyond critical flows | - |\n| [170](https://github.com/agents-squads/agents-squads-web/issues/170) | Add GitHub Actions for automated testing and deployment | - |\n\n---\n\n### **Squads CLI Repo** (8 open issues, 1 PR)\n\n#### Open PR\n| # | Title | Branch |\n|---|-------|--------|\n| [13](https://github.com/agents-squads/squads-cli/pull/13) | feat(sessions): Add active session tracking with JSONL history | `feature/session-tracking` |\n\n#### `squad:cli` - Code Quality\n| # | Title | Type |\n|---|-------|------|\n| [2](https://github.com/agents-squads/squads-cli/issues/2) | Replace 'any' type with proper error typing in issues.ts | c	message	normal	\N	\N	\N	2026-01-04 12:50:46.370332+00	{"source": "hook:Stop", "timestamp": "2026-01-04T09:50:46.351239", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
24	session-1767531046	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: c5bb5d3 chore(memory): Close telemetry issue #9 - pipeline fully operational\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 12:50:46.479049+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T12:50:46Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 12}
25	fd62c9dc-5784-4526-9dae-374db685bce0	local	user	evaluate the status of the infra integration? 	message	normal	\N	\N	\N	2026-01-04 12:56:39.87748+00	{"source": "hook:UserPromptSubmit", "timestamp": "2026-01-04T09:56:39.856492", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
26	fd62c9dc-5784-4526-9dae-374db685bce0	local	assistant	## Infrastructure Integration Status\n\n### Current State\n\n| Component | squads-cli | engram | Gap |\n|-----------|------------|--------|-----|\n| **PostgreSQL** | `postgres:16-alpine` @ 5432 | needs `pgvector/pgvector:pg17` | **Missing pgvector** |\n| **pgvector ext** | ❌ Not installed | Required | **Blocker** |\n| **engram DB** | ❌ Not created | Required | **Blocker** |\n| **Neo4j** | ❌ Not running (profile: full) | Required | **Blocker** |\n| **Redis** | ✅ Running @ 6379 | Can use | Ready |\n| **mem0** | ❌ Not present | Needs adding | **Missing** |\n| **engram-mcp** | ❌ Not present | Needs adding | **Missing** |\n| **OTel** | ✅ Running @ 4318 | Can use | Ready |\n\n### Port Mapping\n\n```\nsquads-cli (.env):     POSTGRES_PORT=5433\nsquads-cli (running):  0.0.0.0:5432->5432  ← Mismatch!\nengram (.env.example): POSTGRES_PORT=5432\n```\n\n### Interesting Overlap\n\nsquads-cli already has `squads.conversations` table:\n```sql\n-- Conversations/memories from Claude Code sessions\nCREATE TABLE IF NOT EXISTS squads.conversations (\n    role, content, message_type, importance, squad, agent, ...\n);\n```\n\nThis overlaps with Engram's memory storage. Could be:\n- **Unified**: Engram stores in `squads.conversations`\n- **Separate**: Engram has own `engram` database with vector search\n\n---\n\n## Work Required\n\n### 1. Database Layer (Blockers)\n\n```bash\n# Option A: Upgrade postgres image (requires rebuild)\n# Change in docker-compose.yml:\nimage: pgvector/pgvector:pg17  # Was: postgres:16-alpine\n\n# Option B: Install pgvector in existing container\ndocker exec squads-postgres psql -U squads -c "CREATE EXTENSION vector;"\n# ❌ Won't work - extension not in alpine image\n```\n\n**Verdict**: Must rebuild with pgvector image.\n\n### 2. Init Script Updates\n\n```sql\n-- Add to init-db.sql\nCREATE DATABASE engram;\n\\c engram\nCREATE EXTENSION IF NOT EXISTS vector;\nCREATE EXTENSION IF NOT EXISTS pg_trgm;\n\n-- Create engram schema\nCREATE SCHEMA IF NOT EXISTS engram;\n```\n\n### 3. Neo4j Activation\n\n```yaml\n# Change in docker-compose.yml:\nneo4j:\n  # Remove: profiles: ["full"]\n  # Make it always start\n```\n\n### 4. Add Services\n\nNeed to add `mem0` and `engram-mcp` services to docker-compose.\n\n---\n\n## Quick Wins (Can Do Now)\n\n1. **Fix port mismatch** - rebuild stack with correct port\n2. **Test Neo4j** - start with `--profile full` to verify it works\n\n## Requires Planning\n\n1. **pgvector migration** - needs postgres rebuild, data backup\n2. **Service integration** - add mem0 + engram-mcp to compose\n3. **Config alignment** - unify ports/credentials\n\n---\n\nWant me to:\n1. **Create a migration script** for the postgres upgrade?\n2. **Start Neo4j** now to test that part?\n3. **Draft the docker-compose changes** for review?	message	normal	\N	\N	\N	2026-01-04 12:57:49.25919+00	{"source": "hook:Stop", "timestamp": "2026-01-04T09:57:49.239454", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
27	session-1767531469	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: c5bb5d3 chore(memory): Close telemetry issue #9 - pipeline fully operational\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 12:57:49.369757+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T12:57:49Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 15}
28	f7e23c60-fddf-4587-adc2-1f9009c01028	local	assistant	MCP is configured and connected, but new tools aren't available in this session.\n\n**To use it, restart Claude Code:**\n```bash\n# Exit current session, then:\nclaude\n```\n\n**Available tools after restart:**\n- `x_search_tweets` - Search tweets by query\n- `x_get_user_timeline` - Get user's recent tweets\n- `x_get_mentions` - Get mentions of a user\n- `x_post_tweet` - Post a tweet\n\n**Created files:**\n```\n~/.claude/mcps/x-mcp/\n├── server.py         # MCP server\n└── requirements.txt  # Dependencies\n```\n\nRestart and try: "search X for 'claude code agents'"	message	normal	\N	\N	\N	2026-01-04 12:58:13.889262+00	{"source": "hook:Stop", "timestamp": "2026-01-04T09:58:13.764938", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
29	session-1767531493	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: c5bb5d3 chore(memory): Close telemetry issue #9 - pipeline fully operational\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 12:58:13.925707+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T12:58:13Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 15}
30	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	local	assistant	## Agents-Squads HQ Evaluation\n\n### What's Working Well\n\n**Architecture Simplicity** — The core design is sound:\n- 63 agents across 10 squads as pure markdown (no microservices)\n- Persistent memory via human-readable `.md` files\n- GitHub-native execution (issues, PRs, Actions)\n- Clear domain separation across repos\n\n**Operational Metrics**:\n- 395 commits in 30 days (13.2/day avg)\n- $15.33 spent vs $200 budget (7.7% utilization)\n- Memory active for 4 leads (intel, web, marketing, product)\n- CLI provides real-time visibility\n\n**Key Strengths**:\n1. **Transparency** — All state inspectable, no black boxes\n2. **Cost control** — Per-agent budgets, model selection per task\n3. **Adaptive loop** — Recall → Observe → Diff → Act → Learn\n4. **Dogfooding** — Running the company on our own architecture\n\n### Gaps & Concerns\n\n| Issue | Impact | Risk |\n|-------|--------|------|\n| **Only 4/63 agents have active memory** | Most agents don't learn | High |\n| **No automated execution** | Manual triggers only | Medium |\n| **0 open PRs/issues across squads** | Pipeline empty | High |\n| **15% goal progress** | Execution velocity low | Medium |\n| **Website squad 0/1 goals** | Revenue site stalled | High |\n\n### Cofounder Honest Assessment\n\n**The architecture is elegant. The execution is weak.**\n\nWe've built a sophisticated system with 63 agents but:\n- Most agents never run (no scheduled triggers active)\n- Memory accumulation is sparse (only leads have state)\n- Cross-squad coordination hasn't been tested at scale\n- Revenue-driving squads (customer, finance) have minimal activity\n\n**Core question**: Are we building infrastructure or generating revenue?\n\n### Recommendations (Priority Order)\n\n1. **Activate scheduled execution** — GitHub Actions cron for intel-lead, customer-lead (HIGH)\n2. **Memory discipline** — Every agent run must update state.md (HIGH)\n3. **Website push** — Complete website goal before new features (HIGH)\n4. **Prune unused agents** — 63 is too many; focus on 10-15 that matter (MEDIUM)\n5. **Customer pipeline** — 0 PRs in customer repo; leads aren't being worked (HIGH)\n\n### Summary\n\nThe HQ implementation proves the architecture works. The squads-cli provides excellent visibility. The memory system design is right.\n\nBut we're 7.7% into our budget with 15% goal progress and 0 active pipeline items. The system is *capable* of running autonomously — it just isn't.\n\n**Next step**: Pick 3 agents that drive revenue and make them run daily.	message	normal	\N	\N	\N	2026-01-04 12:58:36.841284+00	{"source": "hook:Stop", "timestamp": "2026-01-04T09:58:36.822627", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
31	session-1767531516	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: c5bb5d3 chore(memory): Close telemetry issue #9 - pipeline fully operational\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 12:58:36.949231+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T12:58:36Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 16}
34	session-1767531632	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: c5bb5d3 chore(memory): Close telemetry issue #9 - pipeline fully operational\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 13:00:32.484494+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T13:00:32Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 22}
35	fd62c9dc-5784-4526-9dae-374db685bce0	local	user	1. yes do, A and try to don't lose data. \n2. yes \n3. yes 	message	normal	\N	\N	\N	2026-01-04 13:01:54.568529+00	{"source": "hook:UserPromptSubmit", "timestamp": "2026-01-04T10:01:54.549004", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
36	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	local	assistant	Done. Issue #31 solved and closed.\n\n## Summary\n\n| Metric | Result |\n|--------|--------|\n| Tests added | **93** |\n| Coverage (scripts/) | **76.76%** (goal: 60%) |\n| Files created | 4 |\n\n### What was added:\n1. **Vitest infrastructure** - `vitest.config.js` with v8 coverage\n2. **build-pdf.js tests** (39 tests) - slugify, removeFrontmatter, getTableOfContents, getCoverPage, getSectionImage, BRAND/EDITIONS constants\n3. **send-report-email tests** (19 tests) - CORS, email building, report configs, validation\n4. **auth tests** (35 tests) - personal domain detection, JWT structure, lead creation, Slack notifications\n\n### Run tests:\n```bash\nnpm test              # All tests\nnpm run test:coverage # With coverage\n```\n\nCommit: `35c3267` pushed to main.	message	normal	\N	\N	\N	2026-01-04 13:02:59.036528+00	{"source": "hook:Stop", "timestamp": "2026-01-04T10:02:59.018842", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
37	session-1767531778	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: 35c3267 test: Add test coverage for critical components\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 13:02:59.147231+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T13:02:59Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 15}
38	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	local	user	we'll activate schedule execution once the local infra be ready, now I'm doing integration of squads-cli and engram. \nthen with memory working we'll use procastinate over the postgres to dinamically trigger (not just schedules agents (slop)) that are our new priorities and goals, \nyou're being bias because squads dash doesn't offer you updated information 	message	normal	\N	\N	\N	2026-01-04 13:06:30.498564+00	{"source": "hook:UserPromptSubmit", "timestamp": "2026-01-04T10:06:30.479494", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
39	a811cf52-5a86-40d1-8f75-63f7599eb286	local	assistant	**X Search Results: "claude code agents"** (20 tweets)\n\n### Trending Themes\n\n**Building in Public** (38 RTs)\n- @dani_avila7: Claude Code team sharing prompts, agents, and commands openly\n\n**Research/Academic Use** (199 RTs)\n- @ahall_research: Claims Claude Code wrote an entire empirical polisci paper, proving AI agents can contribute to research\n\n**Bolt v2 Launch** (537 RTs)\n- @boltdotnew: "Vibe coding goes pro" - integrating Claude Code + Codex agents with built-in backend\n\n**Power User Insights**\n- @idoshamun: "Creator of Claude Code hasn't opened an IDE in a month. 200 PRs by AI. Runs 10-15 agents in parallel."\n- @DanielleMorrill: Using Claude Code as "chief of staff" for executives/managers\n\n**Developer Pain Points**\n- @hashin: "Coding agents patch failures instead of fixing root causes... confident fixes = inconsistent patterns"\n- @Stevenhurtador: "What do you do while waiting for Claude Code agent to finish? I find myself multitasking - bad for focus"\n\n**Comparisons**\n- @CriB3001: Ranking AI coding tools - Claude Code as "terminal-native agent, reasoning, multi-file"\n\n### High Engagement Posts to Check\n- [Bolt v2 announcement](https://x.com/boltdotnew/status/2007799149434208269) - 537 RTs\n- [Academic paper proof](https://x.com/ahall_research) - 199 RTs\n- [Building in public thread](https://x.com/dani_avila7) - 38 RTs	message	normal	\N	\N	\N	2026-01-04 13:06:47.461224+00	{"source": "hook:Stop", "timestamp": "2026-01-04T10:06:47.441623", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
40	session-1767532007	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: 35c3267 test: Add test coverage for critical components\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 13:06:47.569444+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T13:06:47Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 15}
41	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	local	assistant	Fair correction. I evaluated outputs when you're building the execution engine.\n\n**What I missed:**\n- squads-cli + engram integration = proper memory foundation\n- Procrastinate + postgres = goal-driven triggers (not blind schedules)\n- Static cron = slop; dynamic priority-based execution = intelligent\n\nThe sequence makes sense: memory first → then triggers that respond to priorities, not arbitrary schedules.\n\n**Questions on current work:**\n\n1. What's the engram integration status? (blocking items?)\n2. How will procrastinate determine what to trigger? (goal deltas? memory changes? external events?)\n3. Is the postgres already running or still being set up?\n\nI can look at the engram repo and squads-cli to understand the integration point if helpful.	message	normal	\N	\N	\N	2026-01-04 13:06:47.998913+00	{"source": "hook:Stop", "timestamp": "2026-01-04T10:06:47.983740", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
42	session-1767532007	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: 35c3267 test: Add test coverage for critical components\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 13:06:48.110005+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T13:06:48Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 15}
43	bc488ee3-38ec-41a2-9df0-1af7065105f0	local	user	commit and push for revision 	message	normal	\N	\N	\N	2026-01-04 13:07:22.171257+00	{"source": "hook:UserPromptSubmit", "timestamp": "2026-01-04T10:07:22.151540", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
44	a811cf52-5a86-40d1-8f75-63f7599eb286	local	user	can we post to x ?	message	normal	\N	\N	\N	2026-01-04 13:07:41.086623+00	{"source": "hook:UserPromptSubmit", "timestamp": "2026-01-04T10:07:41.067141", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
45	a811cf52-5a86-40d1-8f75-63f7599eb286	local	assistant	Yes, I have the `x_post_tweet` tool available. I can post tweets up to 280 characters and optionally reply to existing tweets.\n\nWhat would you like to post?	message	normal	\N	\N	\N	2026-01-04 13:07:45.722811+00	{"source": "hook:Stop", "timestamp": "2026-01-04T10:07:45.703697", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
46	session-1767532065	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: 35c3267 test: Add test coverage for critical components\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md;A  .agents/memory/marketing/seo-strategist/executions.md;A  .agents/memory/marketing/seo-strategist/learnings.md;\n	session_end	low	\N	\N	\N	2026-01-04 13:07:45.911381+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T13:07:45Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 17}
47	bc488ee3-38ec-41a2-9df0-1af7065105f0	local	assistant	Done. Pushed `5a2d9b0`:\n- 6 goals marked complete\n- seo-strategist agent added to marketing squad\n- 17 active goals remaining	message	normal	\N	\N	\N	2026-01-04 13:08:11.053352+00	{"source": "hook:Stop", "timestamp": "2026-01-04T10:08:10.966618", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
48	session-1767532090	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: 5a2d9b0 chore(goals): Mark 6 accomplished goals as complete\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 13:08:11.147716+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T13:08:11Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 8}
49	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	local	user	is now part of the ci ? 	message	normal	\N	\N	\N	2026-01-04 13:11:10.830813+00	{"source": "hook:UserPromptSubmit", "timestamp": "2026-01-04T10:11:10.815231", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
50	bc488ee3-38ec-41a2-9df0-1af7065105f0	local	assistant	**PR #13**: https://github.com/agents-squads/squads-cli/pull/13\n\nStack commands pushed. Ready for review/merge.	message	normal	\N	\N	\N	2026-01-04 13:11:26.943552+00	{"source": "hook:Stop", "timestamp": "2026-01-04T10:11:26.868656", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
51	session-1767532286	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: 5a2d9b0 chore(goals): Mark 6 accomplished goals as complete\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 13:11:27.034738+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T13:11:26Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 8}
52	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	local	assistant	Yes, now it is. CI passed in 22s.\n\n```\n✓ Tests workflow\n  ✓ test job (22s)\n  📦 coverage-report artifact uploaded\n```\n\nTests now run automatically on:\n- Push to `main` (when scripts/functions change)\n- PRs targeting `main`	message	normal	\N	\N	\N	2026-01-04 13:12:38.641791+00	{"source": "hook:Stop", "timestamp": "2026-01-04T10:12:38.623115", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
53	session-1767532358	jorgevidaurre	system	Session ended in /Users/jorgevidaurre/agents-squads/hq\nBranch: main\nLast commit: ff65157 ci: Add test workflow to GitHub Actions\nChanges:  M .agents/memory/.last-sync; M .agents/memory/intelligence/intel-lead/executions.md; M .agents/memory/marketing/marketing-lead/executions.md; M .agents/memory/product/product-lead/state.md; M .agents/memory/website/web-lead/executions.md;\n	session_end	low	\N	\N	\N	2026-01-04 13:12:38.737095+00	{"hook": "remember", "git_branch": "main", "captured_at": "2026-01-04T13:12:38Z", "working_dir": "/Users/jorgevidaurre/agents-squads/hq", "git_status_count": 8}
54	bc488ee3-38ec-41a2-9df0-1af7065105f0	local	user	how do I review and approve if my user created the pr ? 	message	normal	\N	\N	\N	2026-01-04 13:13:44.341588+00	{"source": "hook:UserPromptSubmit", "timestamp": "2026-01-04T10:13:44.322041", "working_dir": "/Users/jorgevidaurre/agents-squads/hq"}
\.


--
-- Data for Name: dashboard_snapshots; Type: TABLE DATA; Schema: squads; Owner: squads
--

COPY squads.dashboard_snapshots (id, captured_at, total_squads, total_commits, total_prs_merged, total_issues_closed, total_issues_open, goal_progress_pct, cost_usd, daily_budget_usd, input_tokens, output_tokens, commits_30d, avg_commits_per_day, active_days, peak_commits, peak_date, squads_data, authors_data, repos_data) FROM stdin;
\.


--
-- Data for Name: github_metrics; Type: TABLE DATA; Schema: squads; Owner: squads
--

COPY squads.github_metrics (id, org, repo, metric_date, commits, prs_opened, prs_merged, prs_closed, issues_opened, issues_closed, reviews, additions, deletions, avg_pr_cycle_hours, review_pass_rate, created_at) FROM stdin;
\.


--
-- Data for Name: llm_generations; Type: TABLE DATA; Schema: squads; Owner: squads
--

COPY squads.llm_generations (id, session_id, trace_id, squad, agent, user_id, model, input_tokens, output_tokens, cache_read_tokens, cache_creation_tokens, cost_usd, created_at, duration_ms, metadata) FROM stdin;
1	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	3000	118176	361	0.136384	2026-01-04 12:32:06.364128+00	\N	{}
2	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	5209	32	0	0	0.005369	2026-01-04 12:32:06.364128+00	\N	{}
3	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	229	141351	467	0.079359	2026-01-04 12:32:11.353071+00	\N	{}
4	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	357	32	0	0	0.000517	2026-01-04 12:32:11.353071+00	\N	{}
5	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	299	118537	3042	0.085796	2026-01-04 12:32:16.358265+00	\N	{}
6	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	136	141818	372	0.076674	2026-01-04 12:32:16.358265+00	\N	{}
7	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	385	32	0	0	0.000545	2026-01-04 12:32:16.358265+00	\N	{}
8	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	144	12832	134142	0.848444	2026-01-04 12:32:16.358265+00	\N	{}
9	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	556	32	0	0	0.000716	2026-01-04 12:32:16.358265+00	\N	{}
10	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	169	146974	380	0.080127	2026-01-04 12:32:21.359092+00	\N	{}
11	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	379	32	0	0	0.000539	2026-01-04 12:32:21.359092+00	\N	{}
12	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	166	142190	217	0.076641	2026-01-04 12:32:26.365382+00	\N	{}
13	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	434	32	0	0	0.000594	2026-01-04 12:32:26.365382+00	\N	{}
14	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	190	147354	324	0.080492	2026-01-04 12:32:31.367345+00	\N	{}
15	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	126	142407	265	0.076050	2026-01-04 12:32:31.367345+00	\N	{}
16	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	906	121579	348	0.085655	2026-01-04 12:32:36.377976+00	\N	{}
17	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1287	6	0	0	0.001317	2026-01-04 12:32:36.377976+00	\N	{}
18	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	885	4	0	0	0.000905	2026-01-04 12:32:36.377976+00	\N	{}
19	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	877	4	0	0	0.000897	2026-01-04 12:32:36.377976+00	\N	{}
20	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	887	6	0	0	0.000917	2026-01-04 12:32:36.377976+00	\N	{}
21	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1251	8	0	0	0.001291	2026-01-04 12:32:36.377976+00	\N	{}
22	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	238	147678	310	0.081777	2026-01-04 12:32:36.377976+00	\N	{}
23	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	856	44	0	0	0.001076	2026-01-04 12:32:36.377976+00	\N	{}
24	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	313	142672	785	0.084107	2026-01-04 12:32:46.375451+00	\N	{}
25	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	350	32	0	0	0.000510	2026-01-04 12:32:46.375451+00	\N	{}
26	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	248	143457	2551	0.093912	2026-01-04 12:32:56.377533+00	\N	{}
27	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	137	146008	460	0.079344	2026-01-04 12:33:01.377444+00	\N	{}
28	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	219	146468	354	0.080962	2026-01-04 12:33:06.380924+00	\N	{}
29	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	218	146822	433	0.081607	2026-01-04 12:33:11.386189+00	\N	{}
30	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	514	44	0	0	0.000734	2026-01-04 12:33:11.386189+00	\N	{}
31	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	166	25	0	0	0.000291	2026-01-04 12:33:21.395602+00	\N	{}
32	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	129	147255	340	0.079018	2026-01-04 12:33:21.395602+00	\N	{}
33	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	334	124247	156	0.071499	2026-01-04 12:33:31.396721+00	\N	{}
34	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	228	147595	249	0.081104	2026-01-04 12:33:31.396721+00	\N	{}
35	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	142	124403	453	0.068633	2026-01-04 12:33:36.397527+00	\N	{}
36	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	146	26	0	0	0.000276	2026-01-04 12:34:11.431089+00	\N	{}
37	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	225	147729	136	0.080390	2026-01-04 12:34:21.446056+00	\N	{}
38	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	380	32	0	0	0.000540	2026-01-04 12:34:21.446056+00	\N	{}
39	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	398	32	0	0	0.000558	2026-01-04 12:34:21.446056+00	\N	{}
40	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	131	147865	1413	0.086079	2026-01-04 12:34:31.452136+00	\N	{}
41	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	224	149278	439	0.083023	2026-01-04 12:34:36.453578+00	\N	{}
42	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	339	32	0	0	0.000499	2026-01-04 12:34:36.453578+00	\N	{}
43	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	625	558	149717	349	0.094115	2026-01-04 12:34:46.461319+00	\N	{}
44	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	119	150066	1649	0.088354	2026-01-04 12:34:51.465732+00	\N	{}
45	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	470	41	0	0	0.000675	2026-01-04 12:34:51.465732+00	\N	{}
46	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	122	151715	295	0.080791	2026-01-04 12:34:56.469427+00	\N	{}
47	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	385	32	0	0	0.000545	2026-01-04 12:34:56.469427+00	\N	{}
48	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	232	152010	217	0.083201	2026-01-04 12:35:06.481475+00	\N	{}
49	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	378	32	0	0	0.000538	2026-01-04 12:35:06.481475+00	\N	{}
50	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	395	32	0	0	0.000555	2026-01-04 12:35:06.481475+00	\N	{}
51	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	121	152227	933	0.085010	2026-01-04 12:35:11.481927+00	\N	{}
52	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	382	32	0	0	0.000542	2026-01-04 12:35:11.481927+00	\N	{}
53	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	137	25	0	0	0.000262	2026-01-04 12:35:16.490076+00	\N	{}
54	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	112	153160	213	0.080751	2026-01-04 12:35:21.493245+00	\N	{}
55	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	344	32	0	0	0.000504	2026-01-04 12:35:21.493245+00	\N	{}
56	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	114	153373	176	0.080677	2026-01-04 12:35:26.499113+00	\N	{}
57	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	350	124741	24	0.071321	2026-01-04 12:35:26.499113+00	\N	{}
58	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	182	153549	234	0.082837	2026-01-04 12:35:31.49901+00	\N	{}
59	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	144	26	0	0	0.000274	2026-01-04 12:36:11.543893+00	\N	{}
60	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	712	32	0	0	0.000872	2026-01-04 12:36:16.546904+00	\N	{}
61	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	118	124765	843	0.070641	2026-01-04 12:36:21.553508+00	\N	{}
62	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	407	47599	100305	0.660931	2026-01-04 12:36:26.561766+00	\N	{}
63	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	371	32	0	0	0.000531	2026-01-04 12:36:26.561766+00	\N	{}
64	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	80	125608	163	0.065863	2026-01-04 12:36:31.56443+00	\N	{}
65	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	700	147904	1709	0.102173	2026-01-04 12:36:41.567347+00	\N	{}
66	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	247	149613	811	0.086100	2026-01-04 12:36:51.576256+00	\N	{}
67	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	2440	810	0	10117	0.105681	2026-01-04 12:36:51.576256+00	\N	{}
68	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	477	125771	1057	0.081457	2026-01-04 12:37:01.581978+00	\N	{}
69	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	181	126828	596	0.071714	2026-01-04 12:37:06.591568+00	\N	{}
70	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	5047	14	0	0	0.005117	2026-01-04 12:38:11.62987+00	\N	{}
71	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	3	198	0	5379	0.007717	2026-01-04 12:38:11.62987+00	\N	{}
72	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	3	21	0	5507	0.034959	2026-01-04 12:38:11.62987+00	\N	{}
73	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	129	30	0	0	0.000279	2026-01-04 12:38:31.650644+00	\N	{}
74	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	669	12832	47718	0.321429	2026-01-04 12:38:46.667238+00	\N	{}
75	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	3	407	0	47764	0.061743	2026-01-04 12:38:46.667238+00	\N	{}
76	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	341	32	0	0	0.000501	2026-01-04 12:38:51.672565+00	\N	{}
77	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1877	32	0	0	0.002037	2026-01-04 12:38:51.672565+00	\N	{}
78	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	667	32	0	0	0.000827	2026-01-04 12:38:51.672565+00	\N	{}
79	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	824	32	0	0	0.000984	2026-01-04 12:38:51.672565+00	\N	{}
80	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	371	354	47764	2543	0.010096	2026-01-04 12:38:51.672565+00	\N	{}
81	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1415	32	0	0	0.001575	2026-01-04 12:38:56.67278+00	\N	{}
82	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	379	32	0	0	0.000539	2026-01-04 12:38:56.67278+00	\N	{}
83	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	2777	32	0	0	0.002937	2026-01-04 12:38:56.67278+00	\N	{}
84	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	393	24	0	0	0.000513	2026-01-04 12:46:32.116826+00	\N	{}
85	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	117	12832	114860	0.727266	2026-01-04 12:46:42.123024+00	\N	{}
86	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	123	25	0	0	0.000248	2026-01-04 12:46:47.127333+00	\N	{}
87	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	297	127692	1098	0.078183	2026-01-04 12:46:52.134689+00	\N	{}
88	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	118	21	0	0	0.000223	2026-01-04 12:46:57.141772+00	\N	{}
89	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	739	44	0	0	0.000959	2026-01-04 12:47:02.14568+00	\N	{}
90	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	885	6	0	0	0.000915	2026-01-04 12:47:02.14568+00	\N	{}
91	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1198	6	0	0	0.001228	2026-01-04 12:47:02.14568+00	\N	{}
92	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	886	8	0	0	0.000926	2026-01-04 12:47:02.14568+00	\N	{}
93	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1161	8	0	0	0.001201	2026-01-04 12:47:02.14568+00	\N	{}
94	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	448	12832	137482	0.876928	2026-01-04 12:47:07.150826+00	\N	{}
95	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1111	32	0	0	0.001271	2026-01-04 12:47:12.149353+00	\N	{}
96	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1118	32	0	0	0.001278	2026-01-04 12:47:12.149353+00	\N	{}
97	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	648	56	0	0	0.000928	2026-01-04 12:47:17.157517+00	\N	{}
98	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	7	212	0	55639	0.070616	2026-01-04 12:47:17.157517+00	\N	{}
99	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	7	241	55639	3353	0.010967	2026-01-04 12:47:17.157517+00	\N	{}
100	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	7	274	58992	4721	0.013177	2026-01-04 12:47:22.162241+00	\N	{}
101	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	7	241	63713	3551	0.012022	2026-01-04 12:47:22.162241+00	\N	{}
102	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	419	12832	110105	0.705087	2026-01-04 12:47:27.166169+00	\N	{}
103	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1168	6	0	0	0.001198	2026-01-04 12:47:27.166169+00	\N	{}
104	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	888	6	0	0	0.000918	2026-01-04 12:47:27.166169+00	\N	{}
105	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1151	8	0	0	0.001191	2026-01-04 12:47:27.166169+00	\N	{}
106	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	542	32	0	0	0.000702	2026-01-04 12:47:27.166169+00	\N	{}
107	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	7	375	67264	3406	0.012866	2026-01-04 12:47:27.166169+00	\N	{}
108	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	5061	150314	5323	0.234991	2026-01-04 12:48:07.211995+00	\N	{}
109	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	618	56	0	0	0.000898	2026-01-04 12:48:32.232246+00	\N	{}
110	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	252	128790	3696	0.093845	2026-01-04 12:48:37.237102+00	\N	{}
111	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	258	122937	455	0.070802	2026-01-04 12:48:37.237102+00	\N	{}
112	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	572	32	0	0	0.000732	2026-01-04 12:48:52.2478+00	\N	{}
113	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	431	123392	307	0.074430	2026-01-04 12:48:52.2478+00	\N	{}
114	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	319	32	0	0	0.000479	2026-01-04 12:48:52.2478+00	\N	{}
115	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	7	339	70670	1381	0.010495	2026-01-04 12:48:57.254085+00	\N	{}
116	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	2	2270	0	134486	0.897298	2026-01-04 12:48:57.254085+00	\N	{}
117	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	145	123699	551	0.068968	2026-01-04 12:48:57.254085+00	\N	{}
118	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	7	247	72051	2126	0.011105	2026-01-04 12:49:02.255053+00	\N	{}
119	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	903	32	0	0	0.001063	2026-01-04 12:49:02.255053+00	\N	{}
120	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	761	32	0	0	0.000921	2026-01-04 12:49:02.255053+00	\N	{}
121	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	7	399	74177	1392	0.011160	2026-01-04 12:49:02.255053+00	\N	{}
122	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	210	53982	20652	0.161366	2026-01-04 12:49:07.264892+00	\N	{}
123	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	3	269	0	5389	0.008084	2026-01-04 12:49:17.27494+00	\N	{}
124	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	3	20	0	5517	0.034996	2026-01-04 12:49:17.27494+00	\N	{}
125	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	384	74634	5073	0.078663	2026-01-04 12:49:17.27494+00	\N	{}
126	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	238	79707	696	0.050194	2026-01-04 12:49:27.282984+00	\N	{}
127	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	462	80403	413	0.054373	2026-01-04 12:49:37.283651+00	\N	{}
128	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	135	25	0	0	0.000260	2026-01-04 12:49:42.292252+00	\N	{}
129	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	4392	132486	9774	0.237170	2026-01-04 12:49:47.298668+00	\N	{}
130	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	244	80816	1202	0.054061	2026-01-04 12:49:47.298668+00	\N	{}
131	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	229	142260	4315	0.103864	2026-01-04 12:49:52.297102+00	\N	{}
132	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	128	82018	334	0.046336	2026-01-04 12:49:57.309647+00	\N	{}
133	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	825	12832	47821	0.325972	2026-01-04 12:49:57.309647+00	\N	{}
134	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	363	32	0	0	0.000523	2026-01-04 12:49:57.309647+00	\N	{}
135	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	369	32	0	0	0.000529	2026-01-04 12:49:57.309647+00	\N	{}
136	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	365	32	0	0	0.000525	2026-01-04 12:49:57.309647+00	\N	{}
137	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	363	32	0	0	0.000523	2026-01-04 12:49:57.309647+00	\N	{}
138	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	371	32	0	0	0.000531	2026-01-04 12:49:57.309647+00	\N	{}
139	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	369	32	0	0	0.000529	2026-01-04 12:50:02.310354+00	\N	{}
140	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	381	60653	1133	0.046973	2026-01-04 12:50:12.314345+00	\N	{}
141	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	353	32	0	0	0.000513	2026-01-04 12:50:12.314345+00	\N	{}
142	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	349	32	0	0	0.000509	2026-01-04 12:50:12.314345+00	\N	{}
143	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	357	32	0	0	0.000517	2026-01-04 12:50:12.314345+00	\N	{}
144	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1174	32	0	0	0.001334	2026-01-04 12:50:12.314345+00	\N	{}
145	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	626	61786	1512	0.056033	2026-01-04 12:50:22.335337+00	\N	{}
146	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	2326	32	0	0	0.002486	2026-01-04 12:50:22.335337+00	\N	{}
147	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	343	32	0	0	0.000503	2026-01-04 12:50:22.335337+00	\N	{}
148	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	2186	32	0	0	0.002346	2026-01-04 12:50:22.335337+00	\N	{}
149	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	347	32	0	0	0.000507	2026-01-04 12:50:22.335337+00	\N	{}
150	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1702	32	0	0	0.001862	2026-01-04 12:50:27.337928+00	\N	{}
151	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	446	32	0	0	0.000606	2026-01-04 12:50:27.337928+00	\N	{}
152	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	1777	63298	6187	0.114783	2026-01-04 12:50:52.362009+00	\N	{}
153	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	252	69485	1897	0.052949	2026-01-04 12:51:02.360572+00	\N	{}
154	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	119	27	0	0	0.000254	2026-01-04 12:55:22.664212+00	\N	{}
155	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	631	32	0	0	0.000791	2026-01-04 12:55:27.670673+00	\N	{}
156	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	163	71267	6	0.039796	2026-01-04 12:55:32.673632+00	\N	{}
157	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	804	59	0	0	0.001099	2026-01-04 12:55:32.673632+00	\N	{}
158	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	400	32	0	0	0.000560	2026-01-04 12:55:32.673632+00	\N	{}
159	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	110	12832	69986	0.446619	2026-01-04 12:55:37.679052+00	\N	{}
160	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	418	32	0	0	0.000578	2026-01-04 12:55:37.679052+00	\N	{}
161	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	129	12832	134254	0.848769	2026-01-04 12:55:42.684922+00	\N	{}
162	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	337	32	0	0	0.000497	2026-01-04 12:55:42.684922+00	\N	{}
163	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	443	71273	658	0.050864	2026-01-04 12:55:42.684922+00	\N	{}
164	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	468	32	0	0	0.000628	2026-01-04 12:55:42.684922+00	\N	{}
165	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	427	32	0	0	0.000587	2026-01-04 12:55:42.684922+00	\N	{}
166	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	428	45	0	0	0.000653	2026-01-04 12:55:42.684922+00	\N	{}
167	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	379	32	0	0	0.000539	2026-01-04 12:55:42.684922+00	\N	{}
168	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	103	82818	237	0.045505	2026-01-04 12:55:42.684922+00	\N	{}
169	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1120	32	0	0	0.001280	2026-01-04 12:55:42.684922+00	\N	{}
170	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	186	147086	151	0.079177	2026-01-04 12:55:47.688818+00	\N	{}
171	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	141	83986	718	0.050046	2026-01-04 12:56:02.346065+00	\N	{}
172	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	698	32	0	0	0.000858	2026-01-04 12:56:07.707567+00	\N	{}
173	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	502	72958	18584	0.165219	2026-01-04 12:56:07.707567+00	\N	{}
174	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	93	91542	540	0.051511	2026-01-04 12:56:12.719205+00	\N	{}
175	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	109	84704	547	0.048536	2026-01-04 12:56:12.719205+00	\N	{}
176	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	665	32	0	0	0.000825	2026-01-04 12:56:12.719205+00	\N	{}
177	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	465	92082	332	0.059781	2026-01-04 12:56:22.726107+00	\N	{}
178	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	151	85251	690	0.050753	2026-01-04 12:56:22.726107+00	\N	{}
179	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	555	32	0	0	0.000715	2026-01-04 12:56:22.726107+00	\N	{}
180	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	280	92414	769	0.058053	2026-01-04 12:56:27.731368+00	\N	{}
181	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	278	85941	385	0.052367	2026-01-04 12:56:32.73268+00	\N	{}
182	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	422	93183	327	0.059225	2026-01-04 12:56:42.743402+00	\N	{}
183	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	126	27	0	0	0.000261	2026-01-04 12:56:47.751376+00	\N	{}
184	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	108	93510	718	0.053982	2026-01-04 12:56:47.751376+00	\N	{}
185	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	322	32	0	0	0.000482	2026-01-04 12:56:47.751376+00	\N	{}
186	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	858	86326	550	0.068091	2026-01-04 12:56:47.751376+00	\N	{}
187	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	894	46	0	0	0.001124	2026-01-04 12:56:52.752358+00	\N	{}
188	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	98	147237	748	0.080784	2026-01-04 12:56:52.752358+00	\N	{}
189	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	119	86876	1623	0.056597	2026-01-04 12:56:52.752358+00	\N	{}
190	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	631	32	0	0	0.000791	2026-01-04 12:56:52.752358+00	\N	{}
191	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	293	12832	111324	0.709566	2026-01-04 12:56:57.758111+00	\N	{}
192	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	711	32	0	0	0.000871	2026-01-04 12:56:57.758111+00	\N	{}
193	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	351	32	0	0	0.000511	2026-01-04 12:57:02.763153+00	\N	{}
194	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	95	88499	667	0.050833	2026-01-04 12:57:02.763153+00	\N	{}
195	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1118	32	0	0	0.001278	2026-01-04 12:57:02.763153+00	\N	{}
196	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	547	32	0	0	0.000707	2026-01-04 12:57:07.758157+00	\N	{}
197	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	409	32	0	0	0.000569	2026-01-04 12:57:07.758157+00	\N	{}
198	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	192	147985	454	0.081670	2026-01-04 12:57:12.764126+00	\N	{}
199	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	7	392	0	76553	0.097658	2026-01-04 12:57:12.764126+00	\N	{}
200	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	375	32	0	0	0.000535	2026-01-04 12:57:12.764126+00	\N	{}
201	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	344	32	0	0	0.000504	2026-01-04 12:57:12.764126+00	\N	{}
202	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	344	32	0	0	0.000504	2026-01-04 12:57:12.764126+00	\N	{}
203	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	344	32	0	0	0.000504	2026-01-04 12:57:12.764126+00	\N	{}
204	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	133	89166	921	0.053704	2026-01-04 12:57:12.764126+00	\N	{}
205	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	911	32	0	0	0.001071	2026-01-04 12:57:12.764126+00	\N	{}
206	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	166	148439	248	0.079959	2026-01-04 12:57:17.765835+00	\N	{}
207	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	407	124156	5854	0.108880	2026-01-04 12:57:17.765835+00	\N	{}
208	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	368	32	0	0	0.000528	2026-01-04 12:57:17.765835+00	\N	{}
209	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	340	32	0	0	0.000500	2026-01-04 12:57:17.765835+00	\N	{}
210	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	7	319	76553	674	0.010100	2026-01-04 12:57:17.765835+00	\N	{}
211	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	111	148687	205	0.078440	2026-01-04 12:57:22.771605+00	\N	{}
212	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	610	32	0	0	0.000770	2026-01-04 12:57:22.771605+00	\N	{}
213	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	164	90087	960	0.055183	2026-01-04 12:57:27.777415+00	\N	{}
214	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	7	515	77227	2507	0.013438	2026-01-04 12:57:27.777415+00	\N	{}
215	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	548	32	0	0	0.000708	2026-01-04 12:57:27.777415+00	\N	{}
216	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	345	32	0	0	0.000505	2026-01-04 12:57:27.777415+00	\N	{}
217	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	368	32	0	0	0.000528	2026-01-04 12:57:27.777415+00	\N	{}
218	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	7	283	79734	765	0.010352	2026-01-04 12:57:27.777415+00	\N	{}
219	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	331	130010	2488	0.088870	2026-01-04 12:57:27.777415+00	\N	{}
220	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	2620	94228	317	0.114635	2026-01-04 12:57:32.777723+00	\N	{}
221	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	647	58	0	0	0.000937	2026-01-04 12:57:32.777723+00	\N	{}
222	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	7	282	80499	2480	0.012567	2026-01-04 12:57:32.777723+00	\N	{}
223	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	494	64	0	0	0.000814	2026-01-04 12:57:32.777723+00	\N	{}
224	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	558	32	0	0	0.000718	2026-01-04 12:57:32.777723+00	\N	{}
225	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	345	51	0	0	0.000600	2026-01-04 12:57:32.777723+00	\N	{}
226	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	543	47	0	0	0.000778	2026-01-04 12:57:32.777723+00	\N	{}
227	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	521	38	0	0	0.000711	2026-01-04 12:57:32.777723+00	\N	{}
228	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	117	91047	392	0.050939	2026-01-04 12:57:37.778735+00	\N	{}
229	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	481	38	0	0	0.000671	2026-01-04 12:57:37.778735+00	\N	{}
230	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	276	94545	2672	0.070913	2026-01-04 12:57:37.778735+00	\N	{}
231	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	7	331	82979	2210	0.012722	2026-01-04 12:57:37.778735+00	\N	{}
232	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	400	32	0	0	0.000560	2026-01-04 12:57:37.778735+00	\N	{}
233	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	330	32	0	0	0.000490	2026-01-04 12:57:37.778735+00	\N	{}
234	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	554	148892	523	0.091605	2026-01-04 12:57:42.784809+00	\N	{}
235	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	971	8	0	0	0.001011	2026-01-04 12:57:42.784809+00	\N	{}
236	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1211	8	0	0	0.001251	2026-01-04 12:57:42.784809+00	\N	{}
237	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	898	8	0	0	0.000938	2026-01-04 12:57:42.784809+00	\N	{}
238	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	887	7	0	0	0.000922	2026-01-04 12:57:42.784809+00	\N	{}
239	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	921	8	0	0	0.000961	2026-01-04 12:57:42.784809+00	\N	{}
240	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	926	8	0	0	0.000966	2026-01-04 12:57:42.784809+00	\N	{}
241	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	905	8	0	0	0.000945	2026-01-04 12:57:42.784809+00	\N	{}
242	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	919	8	0	0	0.000959	2026-01-04 12:57:42.784809+00	\N	{}
243	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	168	97217	325	0.054880	2026-01-04 12:57:42.784809+00	\N	{}
244	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	326	32	0	0	0.000486	2026-01-04 12:57:42.784809+00	\N	{}
245	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	128	91439	517	0.052191	2026-01-04 12:57:42.784809+00	\N	{}
246	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	2943	32	0	0	0.003103	2026-01-04 12:57:42.784809+00	\N	{}
247	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	585	32	0	0	0.000745	2026-01-04 12:57:47.791004+00	\N	{}
248	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	134	91956	2771	0.066687	2026-01-04 12:57:52.799682+00	\N	{}
249	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1117	32	0	0	0.001277	2026-01-04 12:57:52.799682+00	\N	{}
250	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	700	45	0	0	0.000925	2026-01-04 12:57:52.799682+00	\N	{}
251	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	1056	132498	963	0.098708	2026-01-04 12:57:57.797803+00	\N	{}
252	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	121	149415	627	0.081691	2026-01-04 12:57:57.797803+00	\N	{}
253	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	373	94727	1159	0.063972	2026-01-04 12:58:02.80451+00	\N	{}
254	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	183	133461	1172	0.078681	2026-01-04 12:58:02.80451+00	\N	{}
255	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	388	32	0	0	0.000548	2026-01-04 12:58:07.812486+00	\N	{}
256	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	123	95886	421	0.053689	2026-01-04 12:58:07.812486+00	\N	{}
257	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	474	32	0	0	0.000634	2026-01-04 12:58:07.812486+00	\N	{}
258	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	128	150042	204	0.079536	2026-01-04 12:58:12.819416+00	\N	{}
259	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	7	2902	85189	820	0.024061	2026-01-04 12:58:17.819353+00	\N	{}
260	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	4394	32	0	0	0.004554	2026-01-04 12:58:17.819353+00	\N	{}
261	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	197	96307	312	0.055069	2026-01-04 12:58:17.819353+00	\N	{}
262	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	230	150246	291	0.082732	2026-01-04 12:58:22.824842+00	\N	{}
263	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	2332	97542	200	0.108361	2026-01-04 12:58:22.824842+00	\N	{}
264	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	609	40	0	0	0.000809	2026-01-04 12:58:27.832361+00	\N	{}
265	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	138	96619	508	0.054974	2026-01-04 12:58:32.838125+00	\N	{}
266	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	469	32	0	0	0.000629	2026-01-04 12:58:32.838125+00	\N	{}
267	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	370	150537	350	0.086756	2026-01-04 12:58:32.838125+00	\N	{}
268	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	303	97127	307	0.058097	2026-01-04 12:58:42.851812+00	\N	{}
269	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	824	12832	56288	0.378856	2026-01-04 12:58:42.851812+00	\N	{}
270	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	275	69120	941	0.047366	2026-01-04 12:58:52.861589+00	\N	{}
271	a811cf52-5a86-40d1-8f75-63f7599eb286	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	3	186	0	5424	0.007713	2026-01-04 12:59:07.876857+00	\N	{}
272	a811cf52-5a86-40d1-8f75-63f7599eb286	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	3	24	0	5552	0.035315	2026-01-04 12:59:07.876857+00	\N	{}
273	a811cf52-5a86-40d1-8f75-63f7599eb286	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	125	25	0	0	0.000250	2026-01-04 12:59:07.876857+00	\N	{}
274	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	3465	97742	2388	0.150461	2026-01-04 12:59:12.879892+00	\N	{}
275	a811cf52-5a86-40d1-8f75-63f7599eb286	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	113	12832	49243	0.317060	2026-01-04 12:59:12.879892+00	\N	{}
276	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	571	32	0	0	0.000731	2026-01-04 12:59:17.883494+00	\N	{}
277	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	242	100130	3520	0.078155	2026-01-04 12:59:22.888628+00	\N	{}
278	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	122	103650	291	0.056734	2026-01-04 12:59:22.888628+00	\N	{}
279	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	138	97434	440	0.054957	2026-01-04 12:59:27.894307+00	\N	{}
280	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	369	32	0	0	0.000529	2026-01-04 12:59:27.894307+00	\N	{}
281	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	113	97874	220	0.053177	2026-01-04 12:59:32.902279+00	\N	{}
282	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	2146	32	0	0	0.002306	2026-01-04 12:59:32.902279+00	\N	{}
283	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	281	98094	2186	0.069775	2026-01-04 12:59:47.915024+00	\N	{}
284	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	357	32	0	0	0.000517	2026-01-04 12:59:47.915024+00	\N	{}
285	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	105	100280	341	0.054936	2026-01-04 12:59:47.915024+00	\N	{}
286	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	392	32	0	0	0.000552	2026-01-04 12:59:47.915024+00	\N	{}
287	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	121	103941	209	0.056342	2026-01-04 12:59:47.915024+00	\N	{}
288	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	360	32	0	0	0.000520	2026-01-04 12:59:52.92021+00	\N	{}
289	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	104	100621	389	0.055382	2026-01-04 12:59:52.92021+00	\N	{}
290	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	366	32	0	0	0.000526	2026-01-04 12:59:52.92021+00	\N	{}
291	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	526	32	0	0	0.000686	2026-01-04 12:59:57.925055+00	\N	{}
292	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	148	104150	341	0.057946	2026-01-04 12:59:57.925055+00	\N	{}
293	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	828	32	0	0	0.000988	2026-01-04 13:00:02.933543+00	\N	{}
294	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	124	101010	175	0.054739	2026-01-04 13:00:02.933543+00	\N	{}
295	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	364	32	0	0	0.000524	2026-01-04 13:00:02.933543+00	\N	{}
296	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	109	101185	193	0.054564	2026-01-04 13:00:02.933543+00	\N	{}
297	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	357	32	0	0	0.000517	2026-01-04 13:00:07.940093+00	\N	{}
298	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	104	101378	390	0.055767	2026-01-04 13:00:07.940093+00	\N	{}
299	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	357	32	0	0	0.000517	2026-01-04 13:00:12.943027+00	\N	{}
300	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	103	101768	166	0.054536	2026-01-04 13:00:12.943027+00	\N	{}
301	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	675	104491	668	0.073336	2026-01-04 13:00:17.946205+00	\N	{}
302	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	1788	32	0	0	0.001948	2026-01-04 13:00:17.946205+00	\N	{}
303	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	132	105159	1013	0.062251	2026-01-04 13:00:22.948347+00	\N	{}
304	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	688	32	0	0	0.000848	2026-01-04 13:00:22.948347+00	\N	{}
305	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	154	106172	702	0.061364	2026-01-04 13:00:27.956214+00	\N	{}
306	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	599	32	0	0	0.000759	2026-01-04 13:00:27.956214+00	\N	{}
307	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	366	101934	1595	0.070126	2026-01-04 13:00:27.956214+00	\N	{}
308	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	163	106874	452	0.060377	2026-01-04 13:00:32.962406+00	\N	{}
309	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	246	103529	414	0.060542	2026-01-04 13:00:37.968704+00	\N	{}
310	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	339	103943	366	0.062784	2026-01-04 13:00:52.978673+00	\N	{}
311	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	142	21	0	0	0.000247	2026-01-04 13:02:03.038325+00	\N	{}
312	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	212	134518	29	0.072790	2026-01-04 13:02:08.035108+00	\N	{}
313	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	367	32	0	0	0.000527	2026-01-04 13:02:23.05612+00	\N	{}
314	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	318	107326	370	0.063966	2026-01-04 13:02:38.074583+00	\N	{}
315	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	660	32	0	0	0.000820	2026-01-04 13:02:38.074583+00	\N	{}
316	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	100	107696	457	0.059244	2026-01-04 13:02:38.074583+00	\N	{}
317	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	351	32	0	0	0.000511	2026-01-04 13:02:43.082928+00	\N	{}
318	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	314	108153	149	0.062898	2026-01-04 13:02:48.081758+00	\N	{}
319	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	558	32	0	0	0.000718	2026-01-04 13:02:48.081758+00	\N	{}
320	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	2346	134547	263	0.127607	2026-01-04 13:02:53.095377+00	\N	{}
321	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	252	108302	546	0.063904	2026-01-04 13:02:58.094154+00	\N	{}
322	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	220	134810	2395	0.087914	2026-01-04 13:03:03.110105+00	\N	{}
323	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	899	4	0	0	0.000919	2026-01-04 13:03:03.110105+00	\N	{}
324	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	254	108848	301	0.062695	2026-01-04 13:03:08.105791+00	\N	{}
325	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	295	109149	374	0.064337	2026-01-04 13:03:18.121202+00	\N	{}
326	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	197	25	0	0	0.000322	2026-01-04 13:06:38.349742+00	\N	{}
327	a811cf52-5a86-40d1-8f75-63f7599eb286	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	443	12832	52392	0.344981	2026-01-04 13:06:53.3607+00	\N	{}
328	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	443	12832	57206	0.375079	2026-01-04 13:06:53.3607+00	\N	{}
329	a811cf52-5a86-40d1-8f75-63f7599eb286	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	204	65224	563	0.041281	2026-01-04 13:07:03.371455+00	\N	{}
330	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	207	70038	562	0.043757	2026-01-04 13:07:03.371455+00	\N	{}
331	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	122	26	0	0	0.000252	2026-01-04 13:07:28.400242+00	\N	{}
332	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	116	12832	92798	0.589354	2026-01-04 13:07:38.404936+00	\N	{}
333	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	531	32	0	0	0.000691	2026-01-04 13:07:38.404936+00	\N	{}
334	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	190	105630	358	0.059843	2026-01-04 13:07:48.408062+00	\N	{}
335	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	616	32	0	0	0.000776	2026-01-04 13:07:48.408062+00	\N	{}
336	a811cf52-5a86-40d1-8f75-63f7599eb286	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	122	25	0	0	0.000247	2026-01-04 13:07:48.408062+00	\N	{}
337	a811cf52-5a86-40d1-8f75-63f7599eb286	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	108	65672	9	0.035642	2026-01-04 13:07:48.408062+00	\N	{}
338	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	315	105988	472	0.063859	2026-01-04 13:07:58.417699+00	\N	{}
339	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	660	32	0	0	0.000820	2026-01-04 13:07:58.417699+00	\N	{}
340	a811cf52-5a86-40d1-8f75-63f7599eb286	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	148	65681	230	0.038028	2026-01-04 13:07:58.417699+00	\N	{}
341	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	86	106460	476	0.058395	2026-01-04 13:08:03.427038+00	\N	{}
342	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	341	32	0	0	0.000501	2026-01-04 13:08:03.427038+00	\N	{}
343	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	97	106936	137	0.056789	2026-01-04 13:08:13.436227+00	\N	{}
344	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	373	32	0	0	0.000533	2026-01-04 13:08:13.436227+00	\N	{}
345	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	65	107073	279	0.056945	2026-01-04 13:08:13.436227+00	\N	{}
346	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	218	107352	185	0.060332	2026-01-04 13:08:28.467151+00	\N	{}
347	21cdee8f-7a09-4e72-a8f5-2dcfeeb1731d	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	3	181	0	5329	0.007569	2026-01-04 13:10:23.592542+00	\N	{}
348	21cdee8f-7a09-4e72-a8f5-2dcfeeb1731d	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	3	26	0	5457	0.034771	2026-01-04 13:10:23.592542+00	\N	{}
349	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	119	25	0	0	0.000244	2026-01-04 13:10:28.6002+00	\N	{}
350	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	333	32	0	0	0.000493	2026-01-04 13:10:33.6047+00	\N	{}
351	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	175	107422	6	0.058174	2026-01-04 13:10:33.6047+00	\N	{}
352	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	510	32	0	0	0.000670	2026-01-04 13:10:33.6047+00	\N	{}
353	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	144	107428	381	0.059735	2026-01-04 13:10:43.599028+00	\N	{}
354	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	370	32	0	0	0.000530	2026-01-04 13:10:43.599028+00	\N	{}
355	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	5661	32	0	0	0.005821	2026-01-04 13:10:48.616031+00	\N	{}
356	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	177	107809	327	0.060413	2026-01-04 13:10:48.616031+00	\N	{}
357	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	266	12832	130015	0.825700	2026-01-04 13:10:58.626086+00	\N	{}
358	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	347	32	0	0	0.000507	2026-01-04 13:11:08.632682+00	\N	{}
359	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	220	142847	378	0.079326	2026-01-04 13:11:18.643621+00	\N	{}
360	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	401	32	0	0	0.000561	2026-01-04 13:11:18.643621+00	\N	{}
361	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	356	32	0	0	0.000516	2026-01-04 13:11:18.643621+00	\N	{}
362	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	124	24	0	0	0.000244	2026-01-04 13:11:18.643621+00	\N	{}
363	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	346	32	0	0	0.000506	2026-01-04 13:11:18.643621+00	\N	{}
364	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	139	12832	96587	0.613610	2026-01-04 13:11:23.646491+00	\N	{}
365	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	436	32	0	0	0.000596	2026-01-04 13:11:23.646491+00	\N	{}
366	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	181	143225	373	0.078509	2026-01-04 13:11:28.654743+00	\N	{}
367	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	133	108136	218	0.058796	2026-01-04 13:11:28.654743+00	\N	{}
368	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	362	32	0	0	0.000522	2026-01-04 13:11:28.654743+00	\N	{}
369	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	66	108354	297	0.057723	2026-01-04 13:11:28.654743+00	\N	{}
370	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	110	109419	262	0.059137	2026-01-04 13:11:33.656755+00	\N	{}
371	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	436	109681	918	0.071518	2026-01-04 13:11:43.671802+00	\N	{}
372	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	173	108651	186	0.059863	2026-01-04 13:11:43.671802+00	\N	{}
373	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	221	110599	484	0.063890	2026-01-04 13:11:48.675508+00	\N	{}
374	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	514	41	0	0	0.000719	2026-01-04 13:11:48.675508+00	\N	{}
375	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	104	111083	419	0.060800	2026-01-04 13:11:58.679108+00	\N	{}
376	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	456	32	0	0	0.000616	2026-01-04 13:11:58.679108+00	\N	{}
377	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	149	111502	258	0.061129	2026-01-04 13:12:03.685425+00	\N	{}
378	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	2986	143598	230	0.147927	2026-01-04 13:12:08.694322+00	\N	{}
379	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	1574	143828	3037	0.130285	2026-01-04 13:12:38.714145+00	\N	{}
380	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	427	32	0	0	0.000587	2026-01-04 13:12:38.714145+00	\N	{}
381	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	146	146865	1627	0.087291	2026-01-04 13:12:43.722295+00	\N	{}
382	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	8	97	111760	368	0.060645	2026-01-04 13:12:43.722295+00	\N	{}
383	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-opus-4-5-20251101	10	198	112128	217	0.062420	2026-01-04 13:12:53.725939+00	\N	{}
384	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	claude-haiku-4-5-20251001	130	26	0	0	0.000260	2026-01-04 13:13:53.781598+00	\N	{}
\.


--
-- Data for Name: sessions; Type: TABLE DATA; Schema: squads; Owner: squads
--

COPY squads.sessions (id, squad, agent, user_id, total_input_tokens, total_output_tokens, total_cost_usd, generation_count, tool_count, started_at, last_activity_at, status) FROM stdin;
f7e23c60-fddf-4587-adc2-1f9009c01028	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	16004	10541	3.534005	45	17	2026-01-04 12:33:21.395602+00	2026-01-04 12:58:32.838125+00	active
21cdee8f-7a09-4e72-a8f5-2dcfeeb1731d	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	6	207	0.042340	2	0	2026-01-04 13:10:23.592542+00	2026-01-04 13:10:23.592542+00	active
8d7a1430-fa3b-492e-9bd3-e779d57ffb24	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	7312	4828	1.823214	38	22	2026-01-04 12:32:11.353071+00	2026-01-04 12:35:31.49901+00	active
7cd1519f-23d1-4212-9540-bd1f60b0fe9b	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	22455	21508	3.642671	81	50	2026-01-04 12:49:17.27494+00	2026-01-04 13:12:53.725939+00	active
bc488ee3-38ec-41a2-9df0-1af7065105f0	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	32147	20793	7.868225	104	52	2026-01-04 12:32:06.364128+00	2026-01-04 13:13:53.781598+00	active
bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	29120	11741	1.647850	54	53	2026-01-04 12:38:11.62987+00	2026-01-04 13:07:03.371455+00	active
fd62c9dc-5784-4526-9dae-374db685bce0	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	26186	16581	3.978696	51	26	2026-01-04 12:32:06.364128+00	2026-01-04 13:12:43.722295+00	active
a811cf52-5a86-40d1-8f75-63f7599eb286	hq	coo	d10f71accbac8e76e34467c6344ac4bdff5ce3068667872b865103c75364ab93	301	1276	0.820517	9	1	2026-01-04 12:59:07.876857+00	2026-01-04 13:07:58.417699+00	active
\.


--
-- Data for Name: task_feedback; Type: TABLE DATA; Schema: squads; Owner: squads
--

COPY squads.task_feedback (id, task_id, quality_score, was_helpful, required_fixes, fix_description, tags, created_at, notes) FROM stdin;
\.


--
-- Data for Name: tasks; Type: TABLE DATA; Schema: squads; Owner: squads
--

COPY squads.tasks (id, task_id, session_id, squad, agent, task_type, description, status, success, retry_count, output_type, output_ref, total_tokens, total_cost_usd, peak_context_tokens, context_utilization_pct, started_at, completed_at, duration_ms, metadata) FROM stdin;
\.


--
-- Data for Name: tool_executions; Type: TABLE DATA; Schema: squads; Owner: squads
--

COPY squads.tool_executions (id, session_id, trace_id, squad, agent, tool_name, success, created_at, duration_ms, metadata) FROM stdin;
1	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Write	t	2026-01-04 12:32:06.364128+00	79	{}
2	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:32:06.364128+00	20724	{}
3	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Bash	t	2026-01-04 12:32:11.353071+00	2616	{}
4	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	TodoWrite	t	2026-01-04 12:32:16.358265+00	6	{}
5	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Bash	t	2026-01-04 12:32:16.358265+00	3501	{}
6	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:32:16.358265+00	108	{}
7	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:32:21.359092+00	122	{}
8	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Bash	t	2026-01-04 12:32:26.365382+00	851	{}
9	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Bash	t	2026-01-04 12:32:31.367345+00	3647	{}
10	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Bash	t	2026-01-04 12:32:46.375451+00	1282	{}
11	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Grep	t	2026-01-04 12:32:46.375451+00	71	{}
12	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Edit	t	2026-01-04 12:32:56.377533+00	9	{}
13	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Grep	t	2026-01-04 12:33:01.377444+00	32	{}
14	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Edit	t	2026-01-04 12:33:06.380924+00	6	{}
15	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Bash	t	2026-01-04 12:33:11.386189+00	2554	{}
16	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Bash	t	2026-01-04 12:34:21.446056+00	725	{}
17	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Bash	t	2026-01-04 12:34:21.446056+00	2532	{}
18	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Bash	f	2026-01-04 12:34:31.452136+00	120	{}
19	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Read	t	2026-01-04 12:34:36.453578+00	1	{}
20	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Bash	t	2026-01-04 12:34:36.453578+00	159	{}
21	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Edit	t	2026-01-04 12:34:46.461319+00	15	{}
22	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Bash	t	2026-01-04 12:34:51.465732+00	141	{}
23	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Bash	t	2026-01-04 12:34:56.469427+00	2417	{}
24	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Bash	t	2026-01-04 12:35:06.481475+00	801	{}
25	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Bash	t	2026-01-04 12:35:06.481475+00	2578	{}
26	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Bash	t	2026-01-04 12:35:11.481927+00	2565	{}
27	8d7a1430-fa3b-492e-9bd3-e779d57ffb24	\N	hq	coo	Bash	t	2026-01-04 12:35:21.493245+00	80	{}
28	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	Bash	t	2026-01-04 12:36:16.546904+00	1986	{}
29	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	mcp__firecrawl__firecrawl_search	f	2026-01-04 12:36:21.553508+00	3331	{}
30	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:36:26.561766+00	138	{}
31	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Grep	t	2026-01-04 12:36:26.561766+00	66	{}
32	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	WebSearch	t	2026-01-04 12:36:51.576256+00	20764	{}
33	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:38:46.667238+00	85	{}
34	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:38:46.667238+00	89	{}
35	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:38:46.667238+00	68	{}
36	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:38:46.667238+00	129	{}
37	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:38:51.672565+00	69	{}
38	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:38:51.672565+00	95	{}
39	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:38:51.672565+00	84	{}
40	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	Read	t	2026-01-04 12:46:42.123024+00	1	{}
41	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Bash	t	2026-01-04 12:47:02.14568+00	2314	{}
42	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	TodoWrite	t	2026-01-04 12:47:07.150826+00	6	{}
43	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Read	t	2026-01-04 12:47:07.150826+00	0	{}
44	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:47:12.149353+00	91	{}
45	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:47:12.149353+00	117	{}
46	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Bash	t	2026-01-04 12:47:17.157517+00	1743	{}
47	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:47:17.157517+00	2	{}
48	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:47:17.157517+00	1	{}
49	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:47:17.157517+00	1	{}
50	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:47:17.157517+00	3	{}
51	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:47:17.157517+00	2	{}
52	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:47:17.157517+00	1	{}
53	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:47:22.162241+00	2	{}
54	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:47:22.162241+00	1	{}
55	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:47:22.162241+00	1	{}
56	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:47:22.162241+00	2	{}
57	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:47:22.162241+00	2	{}
58	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:47:22.162241+00	225	{}
59	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Write	t	2026-01-04 12:48:07.211995+00	122	{}
60	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	Skill	t	2026-01-04 12:48:27.228669+00	18	{}
61	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Bash	t	2026-01-04 12:48:32.232246+00	1541	{}
62	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	f	2026-01-04 12:48:32.232246+00	98	{}
63	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	Read	t	2026-01-04 12:48:37.237102+00	245	{}
64	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	TodoWrite	t	2026-01-04 12:48:37.237102+00	4	{}
65	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:48:52.2478+00	209	{}
66	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:48:52.2478+00	1	{}
67	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	Bash	t	2026-01-04 12:48:52.2478+00	102	{}
68	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	f	2026-01-04 12:48:57.254085+00	103	{}
69	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:48:57.254085+00	0	{}
70	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:48:57.254085+00	1	{}
71	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:49:02.255053+00	63	{}
72	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:49:02.255053+00	79	{}
73	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Read	t	2026-01-04 12:49:07.264892+00	0	{}
74	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Edit	t	2026-01-04 12:49:17.27494+00	8	{}
75	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Edit	t	2026-01-04 12:49:27.282984+00	7	{}
76	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Edit	t	2026-01-04 12:49:37.283651+00	7	{}
77	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	Write	t	2026-01-04 12:49:47.298668+00	119	{}
78	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	TodoWrite	t	2026-01-04 12:49:47.298668+00	6	{}
79	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	Write	t	2026-01-04 12:49:52.297102+00	9	{}
80	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:49:57.309647+00	694	{}
81	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:49:57.309647+00	645	{}
82	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:49:57.309647+00	625	{}
83	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:49:57.309647+00	587	{}
84	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:49:57.309647+00	595	{}
85	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:49:57.309647+00	609	{}
86	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:50:12.314345+00	67	{}
87	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:50:12.314345+00	79	{}
88	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:50:12.314345+00	80	{}
89	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:50:12.314345+00	1169	{}
90	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:50:22.335337+00	1024	{}
91	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:50:22.335337+00	717	{}
92	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:50:22.335337+00	767	{}
93	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:50:22.335337+00	657	{}
94	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:50:22.335337+00	672	{}
95	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:50:22.335337+00	754	{}
96	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:55:27.670673+00	902	{}
97	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:55:32.673632+00	1095	{}
98	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	Bash	t	2026-01-04 12:55:32.673632+00	1783	{}
99	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:55:37.679052+00	617	{}
100	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	Bash	t	2026-01-04 12:55:42.684922+00	114	{}
101	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:55:42.684922+00	80	{}
102	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:55:42.684922+00	87	{}
103	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:55:42.684922+00	100	{}
104	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:55:42.684922+00	114	{}
105	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:55:42.684922+00	639	{}
106	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:56:07.707567+00	7475	{}
107	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	TodoWrite	t	2026-01-04 12:56:07.707567+00	4	{}
108	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Read	t	2026-01-04 12:56:12.719205+00	1	{}
109	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:56:12.719205+00	330	{}
110	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Edit	t	2026-01-04 12:56:22.726107+00	9	{}
111	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:56:22.726107+00	90	{}
112	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Write	t	2026-01-04 12:56:27.731368+00	129	{}
113	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	f	2026-01-04 12:56:32.73268+00	117	{}
114	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Edit	t	2026-01-04 12:56:42.743402+00	8	{}
115	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:56:47.751376+00	74	{}
116	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Edit	t	2026-01-04 12:56:47.751376+00	8	{}
117	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	Bash	t	2026-01-04 12:56:52.752358+00	103	{}
118	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:56:52.752358+00	960	{}
119	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Bash	t	2026-01-04 12:56:57.758111+00	386	{}
120	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Bash	t	2026-01-04 12:57:02.763153+00	251	{}
121	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Read	t	2026-01-04 12:57:02.763153+00	1	{}
122	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:57:02.763153+00	1423	{}
123	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	Bash	t	2026-01-04 12:57:07.758157+00	9201	{}
124	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	f	2026-01-04 12:57:07.758157+00	99	{}
125	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:57:07.758157+00	107	{}
126	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:57:07.758157+00	1	{}
127	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:57:12.764126+00	108	{}
128	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:57:12.764126+00	66	{}
129	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:57:12.764126+00	69	{}
130	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:57:12.764126+00	74	{}
131	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:57:12.764126+00	1100	{}
132	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	Bash	f	2026-01-04 12:57:17.765835+00	420	{}
133	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Bash	t	2026-01-04 12:57:17.765835+00	194	{}
134	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Bash	t	2026-01-04 12:57:17.765835+00	144	{}
135	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Read	t	2026-01-04 12:57:17.765835+00	1	{}
136	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	f	2026-01-04 12:57:17.765835+00	102	{}
137	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:57:17.765835+00	0	{}
138	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:57:17.765835+00	0	{}
139	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	Bash	t	2026-01-04 12:57:22.771605+00	421	{}
140	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:57:27.777415+00	74	{}
141	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:57:27.777415+00	75	{}
142	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:57:27.777415+00	75	{}
143	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:57:27.777415+00	1	{}
144	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:57:27.777415+00	1	{}
145	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:57:27.777415+00	84	{}
146	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Bash	t	2026-01-04 12:57:27.777415+00	147	{}
147	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Bash	t	2026-01-04 12:57:27.777415+00	169	{}
148	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Bash	t	2026-01-04 12:57:27.777415+00	105	{}
149	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Write	t	2026-01-04 12:57:32.777723+00	7	{}
150	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:57:32.777723+00	2	{}
151	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Read	t	2026-01-04 12:57:32.777723+00	1	{}
152	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:57:32.777723+00	230	{}
153	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:57:32.777723+00	80	{}
154	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:57:37.778735+00	142	{}
155	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	TodoWrite	t	2026-01-04 12:57:37.778735+00	4	{}
156	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:57:37.778735+00	72	{}
157	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:57:37.778735+00	100	{}
158	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:57:37.778735+00	224	{}
159	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:57:42.784809+00	154	{}
160	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:57:42.784809+00	536	{}
161	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:57:52.799682+00	2426	{}
162	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	Bash	t	2026-01-04 12:57:52.799682+00	533	{}
163	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	TodoWrite	t	2026-01-04 12:58:02.80451+00	5	{}
164	f7e23c60-fddf-4587-adc2-1f9009c01028	\N	hq	coo	Bash	t	2026-01-04 12:58:07.812486+00	8271	{}
165	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:58:07.812486+00	118	{}
166	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Task	t	2026-01-04 12:58:17.819353+00	1168677	{}
167	bbcfe8ff-24ca-4fa4-a642-2278ab4255e6	\N	hq	coo	Bash	t	2026-01-04 12:58:17.819353+00	2400	{}
168	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Write	t	2026-01-04 12:58:22.824842+00	7	{}
169	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:58:27.832361+00	127	{}
170	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:58:32.838125+00	134	{}
171	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Write	t	2026-01-04 12:59:12.879892+00	8	{}
172	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:59:17.883494+00	139	{}
173	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	TodoWrite	t	2026-01-04 12:59:22.888628+00	4	{}
174	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:59:27.894307+00	2659	{}
175	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:59:32.902279+00	166	{}
176	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:59:47.915024+00	164	{}
177	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:59:47.915024+00	172	{}
178	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:59:47.915024+00	23843	{}
179	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 12:59:52.92021+00	140	{}
180	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 12:59:57.925055+00	1135	{}
181	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 13:00:02.933543+00	786	{}
182	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 13:00:02.933543+00	171	{}
183	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 13:00:02.933543+00	178	{}
184	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 13:00:07.940093+00	171	{}
185	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 13:00:12.943027+00	169	{}
186	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Edit	t	2026-01-04 13:00:17.946205+00	8	{}
187	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 13:00:22.948347+00	776	{}
188	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 13:00:27.956214+00	108	{}
189	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	TodoWrite	t	2026-01-04 13:00:27.956214+00	5	{}
190	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	TodoWrite	t	2026-01-04 13:02:08.035108+00	4	{}
191	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 13:02:23.05612+00	119	{}
192	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 13:02:38.074583+00	89	{}
193	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 13:02:43.082928+00	2716	{}
194	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 13:02:48.081758+00	748	{}
195	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Write	t	2026-01-04 13:02:53.095377+00	6	{}
196	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	TodoWrite	t	2026-01-04 13:02:58.094154+00	6	{}
197	a811cf52-5a86-40d1-8f75-63f7599eb286	\N	hq	coo	mcp__x-mcp__x_search_tweets	t	2026-01-04 13:06:38.349742+00	457	{}
198	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 13:07:38.404936+00	130	{}
199	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 13:07:48.408062+00	113	{}
200	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 13:07:58.417699+00	99	{}
201	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 13:08:03.427038+00	2332	{}
202	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 13:08:13.436227+00	81	{}
203	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Bash	t	2026-01-04 13:10:33.6047+00	107	{}
204	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 13:10:33.6047+00	112	{}
205	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 13:10:43.599028+00	782	{}
206	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Bash	t	2026-01-04 13:10:48.616031+00	15382	{}
207	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	TodoWrite	t	2026-01-04 13:10:58.626086+00	5	{}
208	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Bash	t	2026-01-04 13:11:08.632682+00	10138	{}
209	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Bash	t	2026-01-04 13:11:18.643621+00	78	{}
210	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Bash	t	2026-01-04 13:11:18.643621+00	1541	{}
211	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 13:11:18.643621+00	977	{}
212	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 13:11:23.646491+00	99	{}
213	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	TodoWrite	t	2026-01-04 13:11:28.654743+00	5	{}
214	bc488ee3-38ec-41a2-9df0-1af7065105f0	\N	hq	coo	Bash	t	2026-01-04 13:11:28.654743+00	723	{}
215	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Read	t	2026-01-04 13:11:33.656755+00	1	{}
216	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Write	t	2026-01-04 13:11:43.671802+00	9	{}
217	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 13:11:48.675508+00	2467	{}
218	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 13:11:58.679108+00	1274	{}
219	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Write	t	2026-01-04 13:12:08.694322+00	9	{}
220	fd62c9dc-5784-4526-9dae-374db685bce0	\N	hq	coo	Write	t	2026-01-04 13:12:38.714145+00	9	{}
221	7cd1519f-23d1-4212-9540-bd1f60b0fe9b	\N	hq	coo	Bash	t	2026-01-04 13:12:38.714145+00	32331	{}
\.


--
-- Name: agent_executions_id_seq; Type: SEQUENCE SET; Schema: squads; Owner: squads
--

SELECT pg_catalog.setval('squads.agent_executions_id_seq', 1, false);


--
-- Name: agent_insights_id_seq; Type: SEQUENCE SET; Schema: squads; Owner: squads
--

SELECT pg_catalog.setval('squads.agent_insights_id_seq', 1, false);


--
-- Name: baselines_id_seq; Type: SEQUENCE SET; Schema: squads; Owner: squads
--

SELECT pg_catalog.setval('squads.baselines_id_seq', 1, false);


--
-- Name: cli_events_id_seq; Type: SEQUENCE SET; Schema: squads; Owner: squads
--

SELECT pg_catalog.setval('squads.cli_events_id_seq', 1, false);


--
-- Name: conversations_id_seq; Type: SEQUENCE SET; Schema: squads; Owner: squads
--

SELECT pg_catalog.setval('squads.conversations_id_seq', 54, true);


--
-- Name: dashboard_snapshots_id_seq; Type: SEQUENCE SET; Schema: squads; Owner: squads
--

SELECT pg_catalog.setval('squads.dashboard_snapshots_id_seq', 1, false);


--
-- Name: github_metrics_id_seq; Type: SEQUENCE SET; Schema: squads; Owner: squads
--

SELECT pg_catalog.setval('squads.github_metrics_id_seq', 1, false);


--
-- Name: llm_generations_id_seq; Type: SEQUENCE SET; Schema: squads; Owner: squads
--

SELECT pg_catalog.setval('squads.llm_generations_id_seq', 384, true);


--
-- Name: task_feedback_id_seq; Type: SEQUENCE SET; Schema: squads; Owner: squads
--

SELECT pg_catalog.setval('squads.task_feedback_id_seq', 1, false);


--
-- Name: tasks_id_seq; Type: SEQUENCE SET; Schema: squads; Owner: squads
--

SELECT pg_catalog.setval('squads.tasks_id_seq', 1, false);


--
-- Name: tool_executions_id_seq; Type: SEQUENCE SET; Schema: squads; Owner: squads
--

SELECT pg_catalog.setval('squads.tool_executions_id_seq', 221, true);


--
-- Name: agent_executions agent_executions_pkey; Type: CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.agent_executions
    ADD CONSTRAINT agent_executions_pkey PRIMARY KEY (id);


--
-- Name: agent_insights agent_insights_period_period_start_squad_agent_key; Type: CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.agent_insights
    ADD CONSTRAINT agent_insights_period_period_start_squad_agent_key UNIQUE (period, period_start, squad, agent);


--
-- Name: agent_insights agent_insights_pkey; Type: CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.agent_insights
    ADD CONSTRAINT agent_insights_pkey PRIMARY KEY (id);


--
-- Name: baselines baselines_org_name_key; Type: CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.baselines
    ADD CONSTRAINT baselines_org_name_key UNIQUE (org, name);


--
-- Name: baselines baselines_pkey; Type: CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.baselines
    ADD CONSTRAINT baselines_pkey PRIMARY KEY (id);


--
-- Name: cli_events cli_events_pkey; Type: CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.cli_events
    ADD CONSTRAINT cli_events_pkey PRIMARY KEY (id);


--
-- Name: conversations conversations_pkey; Type: CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.conversations
    ADD CONSTRAINT conversations_pkey PRIMARY KEY (id);


--
-- Name: dashboard_snapshots dashboard_snapshots_pkey; Type: CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.dashboard_snapshots
    ADD CONSTRAINT dashboard_snapshots_pkey PRIMARY KEY (id);


--
-- Name: github_metrics github_metrics_org_repo_metric_date_key; Type: CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.github_metrics
    ADD CONSTRAINT github_metrics_org_repo_metric_date_key UNIQUE (org, repo, metric_date);


--
-- Name: github_metrics github_metrics_pkey; Type: CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.github_metrics
    ADD CONSTRAINT github_metrics_pkey PRIMARY KEY (id);


--
-- Name: llm_generations llm_generations_pkey; Type: CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.llm_generations
    ADD CONSTRAINT llm_generations_pkey PRIMARY KEY (id);


--
-- Name: sessions sessions_pkey; Type: CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.sessions
    ADD CONSTRAINT sessions_pkey PRIMARY KEY (id);


--
-- Name: task_feedback task_feedback_pkey; Type: CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.task_feedback
    ADD CONSTRAINT task_feedback_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_pkey; Type: CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.tasks
    ADD CONSTRAINT tasks_pkey PRIMARY KEY (id);


--
-- Name: tasks tasks_task_id_key; Type: CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.tasks
    ADD CONSTRAINT tasks_task_id_key UNIQUE (task_id);


--
-- Name: tool_executions tool_executions_pkey; Type: CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.tool_executions
    ADD CONSTRAINT tool_executions_pkey PRIMARY KEY (id);


--
-- Name: idx_agent_executions_squad; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_agent_executions_squad ON squads.agent_executions USING btree (squad, agent);


--
-- Name: idx_agent_executions_status; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_agent_executions_status ON squads.agent_executions USING btree (status);


--
-- Name: idx_agent_insights_lookup; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_agent_insights_lookup ON squads.agent_insights USING btree (squad, period, period_start DESC);


--
-- Name: idx_cli_events_anonymous; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_cli_events_anonymous ON squads.cli_events USING btree (anonymous_id);


--
-- Name: idx_cli_events_name; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_cli_events_name ON squads.cli_events USING btree (event_name);


--
-- Name: idx_cli_events_received; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_cli_events_received ON squads.cli_events USING btree (received_at DESC);


--
-- Name: idx_conversations_content_search; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_conversations_content_search ON squads.conversations USING gin (to_tsvector('english'::regconfig, content));


--
-- Name: idx_conversations_created; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_conversations_created ON squads.conversations USING btree (created_at DESC);


--
-- Name: idx_conversations_importance; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_conversations_importance ON squads.conversations USING btree (importance);


--
-- Name: idx_conversations_session; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_conversations_session ON squads.conversations USING btree (session_id);


--
-- Name: idx_conversations_type; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_conversations_type ON squads.conversations USING btree (message_type);


--
-- Name: idx_conversations_user; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_conversations_user ON squads.conversations USING btree (user_id);


--
-- Name: idx_dashboard_snapshots_date; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_dashboard_snapshots_date ON squads.dashboard_snapshots USING btree (captured_at DESC);


--
-- Name: idx_github_metrics_date; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_github_metrics_date ON squads.github_metrics USING btree (metric_date DESC);


--
-- Name: idx_github_metrics_repo; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_github_metrics_repo ON squads.github_metrics USING btree (org, repo);


--
-- Name: idx_llm_generations_created; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_llm_generations_created ON squads.llm_generations USING btree (created_at DESC);


--
-- Name: idx_llm_generations_session; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_llm_generations_session ON squads.llm_generations USING btree (session_id);


--
-- Name: idx_llm_generations_squad; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_llm_generations_squad ON squads.llm_generations USING btree (squad, agent);


--
-- Name: idx_sessions_squad; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_sessions_squad ON squads.sessions USING btree (squad, agent);


--
-- Name: idx_sessions_status; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_sessions_status ON squads.sessions USING btree (status);


--
-- Name: idx_task_feedback_task; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_task_feedback_task ON squads.task_feedback USING btree (task_id);


--
-- Name: idx_tasks_created; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_tasks_created ON squads.tasks USING btree (started_at DESC);


--
-- Name: idx_tasks_squad; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_tasks_squad ON squads.tasks USING btree (squad, agent);


--
-- Name: idx_tasks_status; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_tasks_status ON squads.tasks USING btree (status);


--
-- Name: idx_tool_executions_session; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_tool_executions_session ON squads.tool_executions USING btree (session_id);


--
-- Name: idx_tool_executions_tool; Type: INDEX; Schema: squads; Owner: squads
--

CREATE INDEX idx_tool_executions_tool ON squads.tool_executions USING btree (tool_name);


--
-- Name: task_feedback task_feedback_task_id_fkey; Type: FK CONSTRAINT; Schema: squads; Owner: squads
--

ALTER TABLE ONLY squads.task_feedback
    ADD CONSTRAINT task_feedback_task_id_fkey FOREIGN KEY (task_id) REFERENCES squads.tasks(task_id);


--
-- PostgreSQL database dump complete
--

\unrestrict LJ8zvYQOdQRWTfhhFezeDOuvCpa5ZubtIxBf3dfTnDvCcMT1F1uG89eCEQvwzgL

--
-- PostgreSQL database cluster dump complete
--

