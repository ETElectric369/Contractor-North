-- Public storage bucket for photos/files a VISITOR uploads in the public "Ask Nort" chat
-- (e.g. a photo of their electrical panel). Nort's vision reads them for the estimate, and on
-- lead capture the URLs are attached to the lead so the office sees the actual job.
--
-- public = true  → read-only-by-URL (unguessable random path per file); the site + the model
--   fetch images by URL. Writes are NOT anon: no INSERT policy is granted, so only the
--   service-role upload endpoint (/api/site-chat/upload, the gatekeeper) can put files here.
-- Defense-in-depth caps at the bucket level too: 5MB and image mime types only.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'lead-uploads', 'lead-uploads', true, 5242880,
  array['image/jpeg','image/png','image/webp','image/gif']
)
on conflict (id) do update set
  public = true,
  file_size_limit = 5242880,
  allowed_mime_types = array['image/jpeg','image/png','image/webp','image/gif'];
