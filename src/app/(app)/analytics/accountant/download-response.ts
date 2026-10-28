/**
 * IS THIS THE FILE? The download button's one check, before anything is saved or shared. The
 * verdict moved to lib/download-response.ts in cn-v1138 (the company export's button reads it too);
 * this is the accountant page's door to it, so its tests and imports read as they did.
 */
export {
  XLSX_TYPE,
  ZIP_TYPE,
  SIGNED_OUT_WORDS,
  NOT_THE_FILE_WORDS,
  DIDNT_COME_WORDS,
  downloadVerdict,
  type DownloadResponseFacts,
  type DownloadVerdict,
} from "@/lib/download-response";
