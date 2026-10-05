-- migrate:phase expand
-- Phase 2C (ADR-23): custom fields. Definitions at a workspace, brand, or project scope with an
-- immutable type (formula is a type, OD-11), options, one canonical typed value relation, explicit
-- formula dependencies, versioned field sets with lineage attachments, and access.field_policy
-- (0C §7.1) for custom fields. Values never add columns; person and label values grant no access.

-- ---------------------------------------------------------------------------------------------
-- Definitions
-- ---------------------------------------------------------------------------------------------
CREATE TABLE workflow.field_definition (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  project_id uuid,
  scope_kind text NOT NULL,
  lineage_id uuid NOT NULL,
  applies_to_project boolean NOT NULL,
  applies_to_task boolean NOT NULL,
  name text NOT NULL,
  normalized_name text NOT NULL,
  description text,
  field_type text NOT NULL,
  config jsonb NOT NULL DEFAULT '{}',
  required boolean NOT NULL DEFAULT false,
  presentation text NOT NULL DEFAULT 'primary',
  applicability text NOT NULL DEFAULT 'always',
  view_visibility jsonb NOT NULL DEFAULT '{}',
  formula_ast jsonb,
  formula_version integer NOT NULL DEFAULT 0,
  result_type text,
  extensions jsonb NOT NULL DEFAULT '{}',
  rank text COLLATE "C" NOT NULL,
  state text NOT NULL DEFAULT 'active',
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT field_definition_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT field_definition_public_id_format CHECK (public_id ~ '^fld_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT field_definition_scope_known CHECK (scope_kind IN ('workspace', 'brand', 'project')),
  CONSTRAINT field_definition_scope_shape CHECK (
    (scope_kind = 'workspace' AND brand_id IS NULL AND project_id IS NULL)
    OR (scope_kind = 'brand' AND brand_id IS NOT NULL AND project_id IS NULL)
    OR (scope_kind = 'project' AND brand_id IS NOT NULL AND project_id IS NOT NULL)),
  CONSTRAINT field_definition_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_definition_project_fkey FOREIGN KEY (workspace_id, brand_id, project_id)
    REFERENCES work.project (workspace_id, brand_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_definition_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_definition_applies CHECK (applies_to_project OR applies_to_task),
  CONSTRAINT field_definition_name_text CHECK (char_length(btrim(name)) BETWEEN 1 AND 80 AND name = btrim(name)
    AND tenancy.valid_plain_text(name, 80)),
  CONSTRAINT field_definition_normalized CHECK (normalized_name = lower(regexp_replace(name, '\s+', ' ', 'g'))),
  CONSTRAINT field_definition_description_text CHECK (description IS NULL
    OR (char_length(description) BETWEEN 1 AND 500 AND tenancy.valid_plain_text(description, 500))),
  CONSTRAINT field_definition_type_known CHECK (field_type IN ('text', 'number', 'currency', 'percentage', 'date',
    'person', 'label', 'checkbox', 'url', 'email', 'select', 'formula')),
  CONSTRAINT field_definition_config_object CHECK (jsonb_typeof(config) = 'object' AND pg_column_size(config) <= 16384),
  CONSTRAINT field_definition_presentation_known CHECK (presentation IN ('primary', 'advanced')),
  CONSTRAINT field_definition_applicability_known CHECK (applicability IN ('always', 'via_set')),
  CONSTRAINT field_definition_view_visibility CHECK (jsonb_typeof(view_visibility) = 'object'
    AND pg_column_size(view_visibility) <= 2048),
  CONSTRAINT field_definition_extensions CHECK (jsonb_typeof(extensions) = 'object' AND pg_column_size(extensions) <= 16384),
  CONSTRAINT field_definition_formula_shape CHECK (
    (field_type = 'formula') = (formula_ast IS NOT NULL)
    AND (field_type = 'formula') = (result_type IS NOT NULL)
    AND (formula_ast IS NULL OR (jsonb_typeof(formula_ast) = 'object' AND pg_column_size(formula_ast) <= 65536))),
  CONSTRAINT field_definition_result_type_known CHECK (result_type IS NULL
    OR result_type IN ('number', 'text', 'boolean', 'date')),
  CONSTRAINT field_definition_formula_not_required CHECK (field_type <> 'formula' OR NOT required),
  CONSTRAINT field_definition_formula_version CHECK (formula_version >= 0),
  CONSTRAINT field_definition_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT field_definition_state_known CHECK (state IN ('active', 'archived')),
  CONSTRAINT field_definition_version_nonnegative CHECK (version >= 0)
);
-- Names are not identity, but one active name per scope keeps choices unambiguous; a lineage has
-- at most one active definition per scope (a narrower scope shadows a broader one).
CREATE UNIQUE INDEX field_definition_active_name ON workflow.field_definition (workspace_id, scope_kind,
  coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), normalized_name) WHERE state = 'active';
CREATE UNIQUE INDEX field_definition_active_lineage ON workflow.field_definition (workspace_id, lineage_id, scope_kind,
  coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid)) WHERE state = 'active';
CREATE INDEX field_definition_by_scope ON workflow.field_definition (workspace_id, state, scope_kind, brand_id, project_id, rank, id);
CREATE INDEX field_definition_by_lineage ON workflow.field_definition (workspace_id, lineage_id);
CREATE INDEX field_definition_by_brand ON workflow.field_definition (workspace_id, brand_id);
CREATE INDEX field_definition_by_project ON workflow.field_definition (workspace_id, brand_id, project_id);
CREATE INDEX field_definition_by_creator ON workflow.field_definition (workspace_id, created_by_membership_id);

CREATE FUNCTION workflow.field_definition_guard() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF NEW.field_type IS DISTINCT FROM OLD.field_type OR NEW.lineage_id IS DISTINCT FROM OLD.lineage_id
     OR NEW.scope_kind IS DISTINCT FROM OLD.scope_kind OR NEW.brand_id IS DISTINCT FROM OLD.brand_id
     OR NEW.project_id IS DISTINCT FROM OLD.project_id OR NEW.public_id IS DISTINCT FROM OLD.public_id THEN
    RAISE EXCEPTION 'a field keeps its type, lineage, and scope' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER field_definition_guard BEFORE UPDATE ON workflow.field_definition
  FOR EACH ROW EXECUTE FUNCTION workflow.field_definition_guard();

-- Required custom fields of a transition reference definitions of the same workspace.
ALTER TABLE workflow.transition_requirement ADD CONSTRAINT transition_requirement_definition_fkey
  FOREIGN KEY (workspace_id, definition_id) REFERENCES workflow.field_definition (workspace_id, id) ON DELETE RESTRICT;

-- ---------------------------------------------------------------------------------------------
-- Options (select fields): stable identity; renaming keeps stored meaning.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE workflow.field_option (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  definition_id uuid NOT NULL,
  label text NOT NULL,
  normalized_label text NOT NULL,
  color text NOT NULL,
  rank text COLLATE "C" NOT NULL,
  state text NOT NULL DEFAULT 'active',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT field_option_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT field_option_definition_key UNIQUE (workspace_id, definition_id, id),
  CONSTRAINT field_option_public_id_format CHECK (public_id ~ '^fop_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT field_option_definition_fkey FOREIGN KEY (workspace_id, definition_id)
    REFERENCES workflow.field_definition (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_option_label_text CHECK (char_length(btrim(label)) BETWEEN 1 AND 80 AND label = btrim(label)
    AND tenancy.valid_plain_text(label, 80)),
  CONSTRAINT field_option_normalized CHECK (normalized_label = lower(regexp_replace(label, '\s+', ' ', 'g'))),
  CONSTRAINT field_option_color_format CHECK (color ~ '^#[0-9a-f]{6}$'),
  CONSTRAINT field_option_rank_format CHECK (rank ~ '^[0-9A-Za-z]{1,64}$'),
  CONSTRAINT field_option_state_known CHECK (state IN ('active', 'archived')),
  CONSTRAINT field_option_version_nonnegative CHECK (version >= 0)
);
CREATE UNIQUE INDEX field_option_active_label ON workflow.field_option (definition_id, normalized_label)
  WHERE state = 'active';
CREATE INDEX field_option_by_definition ON workflow.field_option (workspace_id, definition_id, state, rank, id);

-- ---------------------------------------------------------------------------------------------
-- Formula dependencies: explicit edges, acyclic (checked at commit).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE workflow.formula_dependency (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  definition_id uuid NOT NULL,
  depends_on_definition_id uuid NOT NULL,
  CONSTRAINT formula_dependency_pkey PRIMARY KEY (definition_id, depends_on_definition_id),
  CONSTRAINT formula_dependency_definition_fkey FOREIGN KEY (workspace_id, definition_id)
    REFERENCES workflow.field_definition (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT formula_dependency_input_fkey FOREIGN KEY (workspace_id, depends_on_definition_id)
    REFERENCES workflow.field_definition (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT formula_dependency_not_self CHECK (definition_id <> depends_on_definition_id)
);
CREATE INDEX formula_dependency_by_input ON workflow.formula_dependency (workspace_id, depends_on_definition_id);
CREATE INDEX formula_dependency_by_definition ON workflow.formula_dependency (workspace_id, definition_id);

CREATE FUNCTION workflow.assert_formula_acyclic() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
BEGIN
  IF EXISTS (
    WITH RECURSIVE reach(id, depth) AS (
      SELECT d.depends_on_definition_id, 1 FROM workflow.formula_dependency d WHERE d.definition_id = NEW.definition_id
      UNION
      SELECT d.depends_on_definition_id, r.depth + 1 FROM workflow.formula_dependency d
        JOIN reach r ON d.definition_id = r.id WHERE r.depth < 64)
    SELECT 1 FROM reach WHERE id = NEW.definition_id) THEN
    RAISE EXCEPTION 'formula dependencies must be acyclic' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NULL;
END
$$;
CREATE CONSTRAINT TRIGGER formula_dependency_acyclic AFTER INSERT ON workflow.formula_dependency
  DEFERRABLE INITIALLY DEFERRED FOR EACH ROW EXECUTE FUNCTION workflow.assert_formula_acyclic();

-- ---------------------------------------------------------------------------------------------
-- Values: one canonical relation (definition, record); typed JSON plus normalized typed columns.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE workflow.field_value (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  definition_id uuid NOT NULL,
  record_id uuid NOT NULL,
  value jsonb,
  value_text text,
  value_numeric numeric,
  value_date date,
  value_bool boolean,
  value_ref uuid,
  currency_code text,
  computed boolean NOT NULL DEFAULT false,
  formula_version integer,
  error_code text,
  extensions jsonb NOT NULL DEFAULT '{}',
  updated_by_membership_id uuid,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT field_value_pkey PRIMARY KEY (definition_id, record_id),
  CONSTRAINT field_value_definition_fkey FOREIGN KEY (workspace_id, definition_id)
    REFERENCES workflow.field_definition (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_value_record_fkey FOREIGN KEY (workspace_id, record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_value_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_value_updater_fkey FOREIGN KEY (workspace_id, updated_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_value_size CHECK (value IS NULL OR pg_column_size(value) <= 65536),
  CONSTRAINT field_value_extensions CHECK (jsonb_typeof(extensions) = 'object' AND pg_column_size(extensions) <= 16384),
  CONSTRAINT field_value_currency_format CHECK (currency_code IS NULL OR currency_code ~ '^[A-Z]{3}$'),
  CONSTRAINT field_value_error_known CHECK (error_code IS NULL
    OR error_code IN ('missing', 'invalid', 'divide_by_zero', 'cycle', 'overflow')),
  CONSTRAINT field_value_computed_shape CHECK (computed = (formula_version IS NOT NULL)
    AND (error_code IS NULL OR computed) AND (error_code IS NULL OR value IS NULL)),
  CONSTRAINT field_value_present CHECK (value IS NOT NULL OR error_code IS NOT NULL),
  CONSTRAINT field_value_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX field_value_by_record ON workflow.field_value (workspace_id, record_id);
CREATE INDEX field_value_by_definition ON workflow.field_value (workspace_id, definition_id);
CREATE INDEX field_value_by_brand ON workflow.field_value (workspace_id, brand_id);
CREATE INDEX field_value_by_updater ON workflow.field_value (workspace_id, updated_by_membership_id);
-- Typed columns for filters and sorts (3A) and for reference migration (options, labels, people).
CREATE INDEX field_value_numeric ON workflow.field_value (workspace_id, definition_id, value_numeric);
CREATE INDEX field_value_date ON workflow.field_value (workspace_id, definition_id, value_date);
CREATE INDEX field_value_text ON workflow.field_value (workspace_id, definition_id, value_text COLLATE "C");
CREATE INDEX field_value_ref ON workflow.field_value (workspace_id, definition_id, value_ref);
CREATE INDEX field_value_ref_any ON workflow.field_value (workspace_id, value_ref) WHERE value_ref IS NOT NULL;

-- The value's shape matches its definition's type, the typed columns are derived from it, the
-- definition applies to the record kind, the brand root is the record's, and references stay in
-- scope (select options of the definition, labels of the record's brand, members of the workspace).
CREATE FUNCTION workflow.field_value_shape() RETURNS trigger
  LANGUAGE plpgsql
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  d record;
  r record;
  v jsonb := NEW.value;
  t text;
BEGIN
  SELECT field_type, applies_to_project, applies_to_task, result_type INTO d
    FROM workflow.field_definition WHERE workspace_id = NEW.workspace_id AND id = NEW.definition_id;
  SELECT record_type, brand_id INTO r FROM core.record WHERE workspace_id = NEW.workspace_id AND id = NEW.record_id;
  IF d IS NULL OR r IS NULL THEN
    RAISE EXCEPTION 'unknown field or record' USING ERRCODE = 'foreign_key_violation';
  END IF;
  IF NOT ((r.record_type = 'project' AND d.applies_to_project) OR (r.record_type = 'task' AND d.applies_to_task)) THEN
    RAISE EXCEPTION 'the field does not apply to this record kind' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.brand_id IS DISTINCT FROM r.brand_id THEN
    RAISE EXCEPTION 'a value carries its record''s brand' USING ERRCODE = 'check_violation';
  END IF;
  IF NEW.computed <> (d.field_type = 'formula') THEN
    RAISE EXCEPTION 'only formula fields have computed values' USING ERRCODE = 'check_violation';
  END IF;
  NEW.value_text := NULL; NEW.value_numeric := NULL; NEW.value_date := NULL; NEW.value_bool := NULL;
  NEW.value_ref := NULL; NEW.currency_code := NULL;
  IF v IS NULL THEN
    RETURN NEW;
  END IF;
  t := CASE WHEN d.field_type = 'formula' THEN d.result_type ELSE d.field_type END;
  IF t IN ('text', 'url', 'email') THEN
    IF jsonb_typeof(v) <> 'string' OR char_length(v #>> '{}') NOT BETWEEN 1 AND 20000 THEN
      RAISE EXCEPTION 'invalid text value' USING ERRCODE = 'check_violation';
    END IF;
    NEW.value_text := v #>> '{}';
  ELSIF t IN ('number', 'percentage') THEN
    IF jsonb_typeof(v) <> 'string' OR (v #>> '{}') !~ '^-?[0-9]{1,24}(\.[0-9]{1,12})?$' THEN
      RAISE EXCEPTION 'invalid number value' USING ERRCODE = 'check_violation';
    END IF;
    NEW.value_numeric := (v #>> '{}')::numeric;
  ELSIF t = 'currency' THEN
    IF jsonb_typeof(v) <> 'object' OR (v ->> 'minor') !~ '^-?[0-9]{1,18}$' OR (v ->> 'currency') !~ '^[A-Z]{3}$'
       OR (SELECT count(*) FROM jsonb_object_keys(v)) <> 2 THEN
      RAISE EXCEPTION 'invalid currency value' USING ERRCODE = 'check_violation';
    END IF;
    NEW.value_numeric := (v ->> 'minor')::numeric;
    NEW.currency_code := v ->> 'currency';
  ELSIF t = 'date' THEN
    IF jsonb_typeof(v) <> 'string' OR (v #>> '{}') !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' THEN
      RAISE EXCEPTION 'invalid date value' USING ERRCODE = 'check_violation';
    END IF;
    NEW.value_date := (v #>> '{}')::date;
  ELSIF t IN ('checkbox', 'boolean') THEN
    IF jsonb_typeof(v) <> 'boolean' THEN
      RAISE EXCEPTION 'invalid checkbox value' USING ERRCODE = 'check_violation';
    END IF;
    NEW.value_bool := (v #>> '{}')::boolean;
  ELSIF t IN ('person', 'label', 'select') THEN
    IF jsonb_typeof(v) <> 'string' OR (v #>> '{}') !~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' THEN
      RAISE EXCEPTION 'invalid reference value' USING ERRCODE = 'check_violation';
    END IF;
    NEW.value_ref := (v #>> '{}')::uuid;
    IF t = 'select' AND NOT EXISTS (SELECT 1 FROM workflow.field_option o WHERE o.workspace_id = NEW.workspace_id
         AND o.definition_id = NEW.definition_id AND o.id = NEW.value_ref) THEN
      RAISE EXCEPTION 'the option belongs to another field' USING ERRCODE = 'check_violation';
    ELSIF t = 'label' AND NOT EXISTS (SELECT 1 FROM work.label l WHERE l.workspace_id = NEW.workspace_id
         AND l.brand_id = NEW.brand_id AND l.id = NEW.value_ref) THEN
      RAISE EXCEPTION 'a label value must be a label of the record''s brand' USING ERRCODE = 'check_violation';
    ELSIF t = 'person' AND NOT EXISTS (SELECT 1 FROM tenancy.membership m WHERE m.workspace_id = NEW.workspace_id
         AND m.id = NEW.value_ref AND m.kind = 'member') THEN
      RAISE EXCEPTION 'a person value must be a member of this workspace' USING ERRCODE = 'check_violation';
    END IF;
  ELSE
    RAISE EXCEPTION 'unknown field type' USING ERRCODE = 'check_violation';
  END IF;
  RETURN NEW;
END
$$;
CREATE TRIGGER field_value_shape BEFORE INSERT OR UPDATE ON workflow.field_value
  FOR EACH ROW EXECUTE FUNCTION workflow.field_value_shape();

-- ---------------------------------------------------------------------------------------------
-- Field sets: versioned compositions; records attach a version (lineage, not a copy).
-- ---------------------------------------------------------------------------------------------
CREATE TABLE workflow.field_set (
  id uuid PRIMARY KEY,
  public_id text NOT NULL UNIQUE,
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid,
  project_id uuid,
  scope_kind text NOT NULL,
  applies_to_project boolean NOT NULL,
  applies_to_task boolean NOT NULL,
  name text NOT NULL,
  normalized_name text NOT NULL,
  current_version integer NOT NULL DEFAULT 1,
  state text NOT NULL DEFAULT 'active',
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT field_set_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT field_set_public_id_format CHECK (public_id ~ '^fst_[0-9A-HJKMNP-TV-Z]{26}$'),
  CONSTRAINT field_set_scope_known CHECK (scope_kind IN ('workspace', 'brand', 'project')),
  CONSTRAINT field_set_scope_shape CHECK (
    (scope_kind = 'workspace' AND brand_id IS NULL AND project_id IS NULL)
    OR (scope_kind = 'brand' AND brand_id IS NOT NULL AND project_id IS NULL)
    OR (scope_kind = 'project' AND brand_id IS NOT NULL AND project_id IS NOT NULL)),
  CONSTRAINT field_set_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_set_project_fkey FOREIGN KEY (workspace_id, brand_id, project_id)
    REFERENCES work.project (workspace_id, brand_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_set_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_set_applies CHECK (applies_to_project OR applies_to_task),
  CONSTRAINT field_set_name_text CHECK (char_length(btrim(name)) BETWEEN 1 AND 80 AND name = btrim(name)
    AND tenancy.valid_plain_text(name, 80)),
  CONSTRAINT field_set_normalized CHECK (normalized_name = lower(regexp_replace(name, '\s+', ' ', 'g'))),
  CONSTRAINT field_set_current_version CHECK (current_version >= 1),
  CONSTRAINT field_set_state_known CHECK (state IN ('active', 'archived')),
  CONSTRAINT field_set_version_nonnegative CHECK (version >= 0)
);
CREATE UNIQUE INDEX field_set_active_name ON workflow.field_set (workspace_id, scope_kind,
  coalesce(brand_id, '00000000-0000-0000-0000-000000000000'::uuid),
  coalesce(project_id, '00000000-0000-0000-0000-000000000000'::uuid), normalized_name) WHERE state = 'active';
CREATE INDEX field_set_by_scope ON workflow.field_set (workspace_id, state, scope_kind, brand_id, project_id, id);
CREATE INDEX field_set_by_brand ON workflow.field_set (workspace_id, brand_id);
CREATE INDEX field_set_by_project ON workflow.field_set (workspace_id, brand_id, project_id);
CREATE INDEX field_set_by_creator ON workflow.field_set (workspace_id, created_by_membership_id);

CREATE TABLE workflow.field_set_version (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  field_set_id uuid NOT NULL,
  version integer NOT NULL,
  items jsonb NOT NULL,
  created_by_membership_id uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT field_set_version_pkey PRIMARY KEY (field_set_id, version),
  CONSTRAINT field_set_version_set_fkey FOREIGN KEY (workspace_id, field_set_id)
    REFERENCES workflow.field_set (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_set_version_creator_fkey FOREIGN KEY (workspace_id, created_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_set_version_positive CHECK (version >= 1),
  CONSTRAINT field_set_version_items CHECK (jsonb_typeof(items) = 'array' AND jsonb_array_length(items) BETWEEN 1 AND 500
    AND pg_column_size(items) <= 65536)
);
CREATE INDEX field_set_version_by_set ON workflow.field_set_version (workspace_id, field_set_id, version);
CREATE INDEX field_set_version_by_creator ON workflow.field_set_version (workspace_id, created_by_membership_id);

CREATE TABLE workflow.field_set_attachment (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  brand_id uuid NOT NULL,
  record_id uuid NOT NULL,
  field_set_id uuid NOT NULL,
  version integer NOT NULL,
  attached_by_membership_id uuid,
  attached_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT field_set_attachment_pkey PRIMARY KEY (record_id, field_set_id),
  CONSTRAINT field_set_attachment_record_fkey FOREIGN KEY (workspace_id, record_id)
    REFERENCES core.record (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_set_attachment_brand_fkey FOREIGN KEY (workspace_id, brand_id)
    REFERENCES tenancy.brand (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_set_attachment_version_fkey FOREIGN KEY (field_set_id, version)
    REFERENCES workflow.field_set_version (field_set_id, version) ON DELETE RESTRICT,
  CONSTRAINT field_set_attachment_set_fkey FOREIGN KEY (workspace_id, field_set_id)
    REFERENCES workflow.field_set (workspace_id, id) ON DELETE RESTRICT,
  CONSTRAINT field_set_attachment_by_fkey FOREIGN KEY (workspace_id, attached_by_membership_id)
    REFERENCES tenancy.membership (workspace_id, id) ON DELETE RESTRICT
);
CREATE INDEX field_set_attachment_by_record ON workflow.field_set_attachment (workspace_id, record_id);
CREATE INDEX field_set_attachment_by_set ON workflow.field_set_attachment (workspace_id, field_set_id, version);
CREATE INDEX field_set_attachment_by_version ON workflow.field_set_attachment (field_set_id, version);
CREATE INDEX field_set_attachment_by_brand ON workflow.field_set_attachment (workspace_id, brand_id);
CREATE INDEX field_set_attachment_by_member ON workflow.field_set_attachment (workspace_id, attached_by_membership_id);

-- ---------------------------------------------------------------------------------------------
-- Field policy (0C §7.1, AZ-23) for custom field definitions.
-- ---------------------------------------------------------------------------------------------
CREATE TABLE access.field_policy (
  workspace_id uuid NOT NULL REFERENCES tenancy.workspace (id) ON DELETE RESTRICT,
  definition_id uuid NOT NULL,
  read_rule text NOT NULL DEFAULT 'all_readers',
  read_min_level text,
  edit_min_level text,
  guest_visible boolean NOT NULL DEFAULT false,
  index_for_search boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL DEFAULT now(),
  version bigint NOT NULL DEFAULT 0,
  CONSTRAINT field_policy_pkey PRIMARY KEY (definition_id),
  CONSTRAINT field_policy_definition_fkey FOREIGN KEY (workspace_id, definition_id)
    REFERENCES workflow.field_definition (workspace_id, id) ON DELETE CASCADE,
  CONSTRAINT field_policy_read_rule_known CHECK (read_rule IN ('all_readers', 'min_level')),
  CONSTRAINT field_policy_read_shape CHECK ((read_rule = 'min_level') = (read_min_level IS NOT NULL)),
  CONSTRAINT field_policy_levels_known CHECK ((read_min_level IS NULL OR read_min_level IN ('comment', 'edit', 'manage'))
    AND (edit_min_level IS NULL OR edit_min_level IN ('edit', 'manage'))),
  CONSTRAINT field_policy_index_only_open CHECK (NOT index_for_search OR read_rule = 'all_readers'),
  CONSTRAINT field_policy_version_nonnegative CHECK (version >= 0)
);
CREATE INDEX field_policy_by_workspace ON access.field_policy (workspace_id, definition_id);

-- ---------------------------------------------------------------------------------------------
-- Cross-brand task moves carry the task's values, attachments, and approval requests.
-- ---------------------------------------------------------------------------------------------
CREATE OR REPLACE FUNCTION work.move_task_brand(p_tasks uuid[], p_brand uuid) RETURNS integer
  LANGUAGE plpgsql VOLATILE SECURITY DEFINER
  SET search_path = pg_catalog, pg_temp
  AS $$
DECLARE
  ws uuid := exec.current_workspace_id();
  n integer;
BEGIN
  IF ws IS NULL OR p_brand IS NULL OR cardinality(p_tasks) = 0
     OR NOT EXISTS (SELECT 1 FROM tenancy.brand b WHERE b.workspace_id = ws AND b.id = p_brand AND b.lifecycle_state = 'active')
     OR EXISTS (SELECT 1 FROM unnest(p_tasks) AS x(id) LEFT JOIN core.record r ON r.workspace_id = ws AND r.id = x.id
                 WHERE r.id IS NULL OR r.record_type <> 'task' OR r.lifecycle_state <> 'active')
     OR EXISTS (SELECT 1 FROM unnest(p_tasks) AS x(id) LEFT JOIN work.task t ON t.workspace_id = ws AND t.id = x.id
                 WHERE t.id IS NULL OR t.brand_id <> p_brand) THEN
    RAISE EXCEPTION 'move the task rows to an active brand of this workspace first' USING ERRCODE = 'insufficient_privilege';
  END IF;
  UPDATE core.record SET brand_id = p_brand, version = version + 1
   WHERE workspace_id = ws AND id = ANY(p_tasks) AND brand_id <> p_brand;
  GET DIAGNOSTICS n = ROW_COUNT;
  -- Relationships keep both endpoints' brands for hidden-endpoint filtering (0B §3.5).
  UPDATE relations.record_relationship SET from_brand_id = p_brand
   WHERE workspace_id = ws AND from_record_id = ANY(p_tasks);
  UPDATE relations.record_relationship SET to_brand_id = p_brand
   WHERE workspace_id = ws AND to_record_id = ANY(p_tasks);
  -- Values keep their identity (a definition that does not apply in the new brand is not shown;
  -- label values of the old brand cannot follow and are removed by the command first).
  UPDATE workflow.field_value SET brand_id = p_brand WHERE workspace_id = ws AND record_id = ANY(p_tasks);
  UPDATE workflow.field_set_attachment SET brand_id = p_brand WHERE workspace_id = ws AND record_id = ANY(p_tasks);
  -- Pending approvals go stale with the record version; their brand root follows the record.
  UPDATE workflow.approval_request SET brand_id = p_brand WHERE workspace_id = ws AND record_id = ANY(p_tasks);
  RETURN n;
END
$$;

-- ---------------------------------------------------------------------------------------------
-- Row-level security and grants
-- ---------------------------------------------------------------------------------------------
ALTER TABLE workflow.field_definition ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.field_definition FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow.field_definition
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE workflow.field_option ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.field_option FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow.field_option
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE workflow.formula_dependency ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.formula_dependency FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow.formula_dependency
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE workflow.field_value ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.field_value FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow.field_value
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE workflow.field_set ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.field_set FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow.field_set
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE workflow.field_set_version ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.field_set_version FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow.field_set_version
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE workflow.field_set_attachment ENABLE ROW LEVEL SECURITY;
ALTER TABLE workflow.field_set_attachment FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON workflow.field_set_attachment
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());
ALTER TABLE access.field_policy ENABLE ROW LEVEL SECURITY;
ALTER TABLE access.field_policy FORCE ROW LEVEL SECURITY;
CREATE POLICY tenant_isolation ON access.field_policy
  USING (workspace_id = exec.current_workspace_id()) WITH CHECK (workspace_id = exec.current_workspace_id());

REVOKE ALL ON workflow.field_definition, workflow.field_option, workflow.formula_dependency, workflow.field_value,
  workflow.field_set, workflow.field_set_version, workflow.field_set_attachment, access.field_policy FROM PUBLIC;
GRANT SELECT, INSERT, DELETE ON workflow.field_definition, workflow.field_option, workflow.formula_dependency,
  workflow.field_value, workflow.field_set, workflow.field_set_attachment, access.field_policy TO app_rw;
GRANT UPDATE (name, normalized_name, description, config, required, presentation, applicability, view_visibility,
  formula_ast, formula_version, result_type, applies_to_project, applies_to_task, extensions, rank, state, updated_at, version)
  ON workflow.field_definition TO app_rw;
GRANT UPDATE (label, normalized_label, color, rank, state, updated_at, version) ON workflow.field_option TO app_rw;
GRANT UPDATE (value, computed, formula_version, error_code, extensions, updated_by_membership_id, updated_at, version)
  ON workflow.field_value TO app_rw;
GRANT UPDATE (name, normalized_name, current_version, state, updated_at, version) ON workflow.field_set TO app_rw;
GRANT UPDATE (version, attached_by_membership_id, attached_at) ON workflow.field_set_attachment TO app_rw;
-- Set versions are immutable once written.
GRANT SELECT, INSERT ON workflow.field_set_version TO app_rw;
GRANT UPDATE (read_rule, read_min_level, edit_min_level, guest_visible, index_for_search, updated_at, version)
  ON access.field_policy TO app_rw;
-- The worker reads configuration and removes a purged record's values and attachments.
GRANT SELECT ON workflow.field_definition, workflow.field_option, workflow.formula_dependency, workflow.field_set,
  workflow.field_set_version, access.field_policy TO app_worker;
GRANT SELECT, DELETE ON workflow.field_value, workflow.field_set_attachment TO app_worker;

REVOKE ALL ON FUNCTION workflow.field_definition_guard(), workflow.assert_formula_acyclic(),
  workflow.field_value_shape() FROM PUBLIC;
