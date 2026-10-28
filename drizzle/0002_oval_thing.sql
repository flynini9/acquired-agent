CREATE TABLE `acquired_usage` (
	`id` text PRIMARY KEY NOT NULL,
	`used` integer NOT NULL,
	`expires_at` integer NOT NULL
);
--> statement-breakpoint
ALTER TABLE `routes` ADD `owner_id` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `owner_id` text;