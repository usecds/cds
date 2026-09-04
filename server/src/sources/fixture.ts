import { ContentSource, CollectionItem, SourceMedia } from "../types.js";

export class FixtureSource implements ContentSource {
  private collections: Record<string, CollectionItem[]>;
  private media: SourceMedia[];

  constructor(
    collections?: Record<string, CollectionItem[]>,
    media?: SourceMedia[]
  ) {
    this.collections = collections || {
      categories: [
        {
          id: "cat_apparel",
          key: "apparel",
          translations: {
            en: { name: "Apparel" },
            de: { name: "Kleidung" }
          }
        },
        {
          id: "cat_electronics",
          key: "electronics",
          translations: {
            en: { name: "Electronics" },
            de: { name: "Elektronik" }
          }
        }
      ],
      products: [
        {
          id: "prod_tshirt",
          key: "classic-tshirt",
          translations: {
            en: { title: "Classic T-Shirt", description: "An everyday essential." },
            de: { title: "Klassisches T-Shirt", description: "Ein Alltags-Klassiker." }
          },
          references: [
            { collection: "categories", id: "cat_apparel" }
          ],
          media: [
            "products/tshirt.png"
          ]
        },
        {
          id: "prod_phone",
          key: "smart-phone",
          translations: {
            en: { title: "Smart Phone", description: "Stay connected." },
            de: { title: "Smartphone", description: "Immer in Verbindung." }
          },
          references: [
            { collection: "categories", id: "cat_electronics" }
          ],
          media: [
            "products/phone.png"
          ]
        }
      ]
    };

    this.media = media || [
      {
        virtualPath: "products/tshirt.png",
        content: Buffer.from("fakedata-tshirt-png-image-content-here"),
        mimeType: "image/png"
      },
      {
        virtualPath: "products/phone.png",
        content: Buffer.from("fakedata-phone-png-image-content-here"),
        mimeType: "image/png"
      }
    ];
  }

  async getCollections(): Promise<Record<string, CollectionItem[]>> {
    return this.collections;
  }

  async getMedia(): Promise<SourceMedia[]> {
    return this.media;
  }
}
