CREATE TABLE `acquired_build_lock` (
	`id` text PRIMARY KEY NOT NULL,
	`request_id` text NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE `acquired_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`action` text NOT NULL,
	`status` text NOT NULL,
	`route_id` text,
	`metrics` text NOT NULL,
	`created_at` integer NOT NULL
);
