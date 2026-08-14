CREATE TABLE `servers` (
	`id` text PRIMARY KEY NOT NULL,
	`game_slug` text NOT NULL,
	`name` text NOT NULL,
	`install_dir` text NOT NULL,
	`unit_name` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `servers_install_dir_unique` ON `servers` (`install_dir`);--> statement-breakpoint
CREATE UNIQUE INDEX `servers_unit_name_unique` ON `servers` (`unit_name`);--> statement-breakpoint
ALTER TABLE `backups` ADD `server_id` text DEFAULT 'default' NOT NULL;--> statement-breakpoint
ALTER TABLE `schedules` ADD `server_id` text DEFAULT 'default' NOT NULL;