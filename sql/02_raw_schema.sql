-- Reference DDL for the RAW tables this pipeline consumes.
-- Dumped from the live database (pg_dump --schema-only) so a forker can
-- recreate them exactly; see docs/DATA.md for where the data itself comes
-- from and how to load it. build.py never runs this file: the raw load is a
-- one-time manual step, and the sponsors schema never writes to these tables.

\restrict 34VhM1FKqUlcY8gqYVVdXSpYXiyMPTdfqIPlRuBHTzeacnF9J0QKyQsPAVjpZf4
CREATE TABLE public.lca_disclosure (
    id bigint NOT NULL,
    case_number text,
    case_status text,
    received_date date,
    decision_date date,
    original_cert_date date,
    visa_class text,
    job_title text,
    soc_code text,
    soc_title text,
    full_time_position text,
    begin_date date,
    end_date date,
    total_worker_positions integer,
    new_employment integer,
    continued_employment integer,
    change_previous_employment integer,
    new_concurrent_employment integer,
    change_employer integer,
    amended_petition integer,
    employer_name text,
    trade_name_dba text,
    employer_address1 text,
    employer_address2 text,
    employer_city text,
    employer_state text,
    employer_postal_code text,
    employer_country text,
    employer_province text,
    employer_phone text,
    employer_phone_ext text,
    employer_fein text,
    naics_code text,
    employer_poc_last_name text,
    employer_poc_first_name text,
    employer_poc_middle_name text,
    employer_poc_job_title text,
    employer_poc_address1 text,
    employer_poc_address2 text,
    employer_poc_city text,
    employer_poc_state text,
    employer_poc_postal_code text,
    employer_poc_country text,
    employer_poc_province text,
    employer_poc_phone text,
    employer_poc_phone_ext text,
    employer_poc_email text,
    agent_representing_employer text,
    agent_attorney_last_name text,
    agent_attorney_first_name text,
    agent_attorney_middle_name text,
    agent_attorney_address1 text,
    agent_attorney_address2 text,
    agent_attorney_city text,
    agent_attorney_state text,
    agent_attorney_postal_code text,
    agent_attorney_country text,
    agent_attorney_province text,
    agent_attorney_phone text,
    agent_attorney_phone_ext text,
    agent_attorney_email_address text,
    lawfirm_name_business_name text,
    lawfirm_business_fein text,
    state_of_highest_court text,
    name_of_highest_state_court text,
    worksite_workers integer,
    secondary_entity text,
    secondary_entity_business_name text,
    worksite_address1 text,
    worksite_address2 text,
    worksite_city text,
    worksite_county text,
    worksite_state text,
    worksite_postal_code text,
    wage_rate_of_pay_from numeric,
    wage_rate_of_pay_to numeric,
    wage_unit_of_pay text,
    prevailing_wage numeric,
    pw_unit_of_pay text,
    pw_tracking_number text,
    pw_wage_level text,
    pw_oes_year text,
    pw_other_source text,
    pw_other_year text,
    pw_survey_publisher text,
    pw_survey_name text,
    total_worksite_locations integer,
    agree_to_lc_statement text,
    h_1b_dependent text,
    willful_violator text,
    support_h1b text,
    statutory_basis text,
    appendix_a_attached text,
    public_disclosure text,
    preparer_last_name text,
    preparer_first_name text,
    preparer_middle_initial text,
    preparer_business_name text,
    preparer_email text,
    source_fiscal_year smallint,
    source_quarter smallint
);
CREATE SEQUENCE public.lca_disclosure_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.lca_disclosure_id_seq OWNED BY public.lca_disclosure.id;
CREATE TABLE public.perm_disclosure (
    id bigint NOT NULL,
    case_number text,
    case_status text,
    received_date date,
    decision_date date,
    employer_name text,
    employer_trade_name text,
    employer_city text,
    employer_state text,
    employer_postal_code text,
    employer_fein text,
    naics_code text,
    job_title text,
    pw_soc_code text,
    pw_soc_title text,
    pw_skill_level text,
    pw_wage numeric,
    pw_unit_of_pay text,
    pw_wage_source text,
    wage_offer_from numeric,
    wage_offer_to numeric,
    wage_offer_unit_of_pay text,
    worksite_city text,
    worksite_state text,
    worksite_postal_code text,
    bls_area text,
    source_fiscal_year smallint,
    source_quarter smallint,
    source_form text
);
CREATE SEQUENCE public.perm_disclosure_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.perm_disclosure_id_seq OWNED BY public.perm_disclosure.id;
CREATE TABLE public.pwd_disclosure (
    id bigint NOT NULL,
    case_number text,
    case_status text,
    received_date date,
    determination_date date,
    visa_class text,
    employer_legal_business_name text,
    trade_name_dba text,
    employer_city text,
    employer_state text,
    employer_postal_code text,
    employer_fein text,
    naics_code text,
    job_title text,
    suggested_soc_code text,
    suggested_soc_title text,
    primary_worksite_city text,
    primary_worksite_county text,
    primary_worksite_state text,
    primary_worksite_postal_code text,
    pwd_soc_code text,
    pwd_soc_title text,
    pwd_wage_rate numeric,
    pwd_unit_of_pay text,
    pwd_oes_wage_level text,
    pwd_wage_source text,
    pwd_survey_name text,
    alt_pwd_wage_rate numeric,
    alt_pwd_unit_of_pay text,
    alt_pwd_oes_wage_level text,
    bls_area text,
    source_fiscal_year smallint,
    source_quarter smallint,
    source_form text
);
CREATE SEQUENCE public.pwd_disclosure_id_seq
    START WITH 1
    INCREMENT BY 1
    NO MINVALUE
    NO MAXVALUE
    CACHE 1;
ALTER SEQUENCE public.pwd_disclosure_id_seq OWNED BY public.pwd_disclosure.id;
ALTER TABLE ONLY public.lca_disclosure ALTER COLUMN id SET DEFAULT nextval('public.lca_disclosure_id_seq'::regclass);
ALTER TABLE ONLY public.perm_disclosure ALTER COLUMN id SET DEFAULT nextval('public.perm_disclosure_id_seq'::regclass);
ALTER TABLE ONLY public.pwd_disclosure ALTER COLUMN id SET DEFAULT nextval('public.pwd_disclosure_id_seq'::regclass);
ALTER TABLE ONLY public.lca_disclosure
    ADD CONSTRAINT lca_disclosure_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.perm_disclosure
    ADD CONSTRAINT perm_disclosure_pkey PRIMARY KEY (id);
ALTER TABLE ONLY public.pwd_disclosure
    ADD CONSTRAINT pwd_disclosure_pkey PRIMARY KEY (id);
CREATE INDEX idx_lca_case_status ON public.lca_disclosure USING btree (case_status);
CREATE INDEX idx_lca_employer_name ON public.lca_disclosure USING btree (employer_name);
CREATE INDEX idx_lca_job_title_fts ON public.lca_disclosure USING gin (to_tsvector('english'::regconfig, job_title));
CREATE INDEX idx_lca_pw_wage_level ON public.lca_disclosure USING btree (pw_wage_level);
CREATE INDEX idx_lca_soc_code ON public.lca_disclosure USING btree (soc_code);
CREATE INDEX idx_lca_source ON public.lca_disclosure USING btree (source_fiscal_year, source_quarter);
CREATE INDEX idx_lca_visa_class ON public.lca_disclosure USING btree (visa_class);
CREATE INDEX idx_lca_wage_unit ON public.lca_disclosure USING btree (wage_unit_of_pay);
CREATE INDEX idx_lca_worksite_city ON public.lca_disclosure USING btree (worksite_city);
CREATE INDEX idx_lca_worksite_state ON public.lca_disclosure USING btree (worksite_state);
CREATE INDEX idx_perm_case_status ON public.perm_disclosure USING btree (case_status);
CREATE INDEX idx_perm_employer_name ON public.perm_disclosure USING btree (employer_name);
CREATE INDEX idx_perm_job_title_fts ON public.perm_disclosure USING gin (to_tsvector('english'::regconfig, job_title));
CREATE INDEX idx_perm_skill_level ON public.perm_disclosure USING btree (pw_skill_level);
CREATE INDEX idx_perm_soc_code ON public.perm_disclosure USING btree (pw_soc_code);
CREATE INDEX idx_perm_source ON public.perm_disclosure USING btree (source_fiscal_year, source_quarter);
CREATE INDEX idx_perm_wage_offer_unit ON public.perm_disclosure USING btree (wage_offer_unit_of_pay);
CREATE INDEX idx_perm_worksite_city ON public.perm_disclosure USING btree (worksite_city);
CREATE INDEX idx_perm_worksite_state ON public.perm_disclosure USING btree (worksite_state);
CREATE INDEX idx_pwd_bls_area ON public.pwd_disclosure USING btree (bls_area);
CREATE INDEX idx_pwd_case_status ON public.pwd_disclosure USING btree (case_status);
CREATE INDEX idx_pwd_soc_code ON public.pwd_disclosure USING btree (pwd_soc_code);
CREATE INDEX idx_pwd_source ON public.pwd_disclosure USING btree (source_fiscal_year, source_quarter);
CREATE INDEX idx_pwd_unit_of_pay ON public.pwd_disclosure USING btree (pwd_unit_of_pay);
CREATE INDEX idx_pwd_visa_class ON public.pwd_disclosure USING btree (visa_class);
CREATE INDEX idx_pwd_wage_level ON public.pwd_disclosure USING btree (pwd_oes_wage_level);
CREATE INDEX idx_pwd_worksite_city ON public.pwd_disclosure USING btree (primary_worksite_city);
CREATE INDEX idx_pwd_worksite_state ON public.pwd_disclosure USING btree (primary_worksite_state);
\unrestrict 34VhM1FKqUlcY8gqYVVdXSpYXiyMPTdfqIPlRuBHTzeacnF9J0QKyQsPAVjpZf4
