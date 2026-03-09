export const createOpencodeMessageId = () => `msg_${crypto.randomUUID().replaceAll("-", "")}`
