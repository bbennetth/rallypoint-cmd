PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_backups` (
	`id` text PRIMARY KEY NOT NULL,
	`server_id` text DEFAULT 'default' NOT NULL,
	`filename` text NOT NULL,
	`size_bytes` integer NOT NULL,
	`sha256` text NOT NULL,
	`world_id` text,
	`build_id` text,
	`kind` text NOT NULL,
	`created_at` integer DEFAULT (unixepoch() * 1000) NOT NULL
);
--> statement-breakpoint
INSERT INTO `__new_backups`("id", "server_id", "filename", "size_bytes", "sha256", "world_id", "build_id", "kind", "created_at") SELECT "id", "server_id", "filename", "size_bytes", "sha256", "world_id", "build_id", "kind", "created_at" FROM `backups`;--> statement-breakpoint
DROP TABLE `backups`;--> statement-breakpoint
ALTER TABLE `__new_backups` RENAME TO `backups`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `backups_filename_unique` ON `backups` (`filename`);