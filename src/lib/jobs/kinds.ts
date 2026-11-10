// Side-effect imports of every feature's job module. The tick route imports
// this file so a deployment defines every kind before it claims one.
import "./maintenance.ts";
import "../projectContext/jobs.ts";
import { registerCostJobs } from "../costs/jobs.ts";

registerCostJobs();
import "../pricing/jobs.ts";
import "../schedules/aiVisibilitySchedules.jobs.ts";
import "../email/jobs.ts";
import "../ga4/retention.ts";
import "../indexnow/jobs.ts";
import "../audit/job.ts";
