# The module that creates a Review item applies its decision

Review stores Review items and decisions and computes agreement stats, nothing else. The module that created an item applies the decided item: Discovery applies ai_merge, Matching applies ai_fit_rejection, Mail applies mail_match. Letting Review apply decisions would make it depend on every other module while they depend on it for creating items, a dependency cycle.
