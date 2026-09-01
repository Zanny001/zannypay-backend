ALTER TABLE "ChatMessage" ALTER COLUMN "body" DROP NOT NULL;
ALTER TABLE "ChatMessage" ADD COLUMN "attachmentData" TEXT;
ALTER TABLE "ChatMessage" ADD COLUMN "attachmentMimeType" TEXT;
