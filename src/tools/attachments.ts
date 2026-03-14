export type AttachmentSummary = {
  attachmentId: string;
  name: string;
  contentType: string | null;
  size: number;
  url: string;
};

export const formatAttachmentList = (attachments: AttachmentSummary[]) => {
  return attachments.map((attachment) => {
    return {
      attachmentId: attachment.attachmentId,
      name: attachment.name,
      size: attachment.size,
      type: attachment.contentType ?? "unknown",
      url: attachment.url,
    };
  });
};
