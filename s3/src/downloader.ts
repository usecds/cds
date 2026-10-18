import { AwsClient } from "aws4fetch";
import { HttpDownloader } from "@usecds/client";

export interface S3DownloaderConfig {
  /** The S3 server's URL ("https://s3.eu-central-1.amazonaws.com", "http://localhost:8333") */
  endpoint: string;
  bucket: string;
  /** The project's folder in the bucket, as the publisher wrote it */
  prefix?: string;
  /** The device group's read-only key */
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
  region?: string;
}

/**
 * Reads a CDS store from a private S3 bucket: the same requests as HttpDownloader (channel
 * manifest with If-None-Match, release manifest, objects, media), each signed (SigV4) with the
 * device group's key. No proxy: the bucket's policy decides what the key may read. Path-style
 * URLs (endpoint/bucket/prefix/...). The signing runs on fetch and Web Crypto (Node and browsers).
 */
export class S3Downloader extends HttpDownloader {
  constructor(config: S3DownloaderConfig) {
    const aws = new AwsClient({
      accessKeyId: config.accessKeyId,
      secretAccessKey: config.secretAccessKey,
      ...(config.sessionToken ? { sessionToken: config.sessionToken } : {}),
      service: "s3",
      region: config.region ?? "us-east-1"
    });
    const prefix = (config.prefix ?? "").replace(/^\/+|\/+$/g, "");
    const base = [config.endpoint.replace(/\/+$/, ""), encodeURIComponent(config.bucket), ...(prefix ? [prefix] : [])].join("/");
    super(base, {}, (url, init) => aws.fetch(url, init));
  }
}
